// =============================================================================
// Jira -> Claude 루프 자동화 대시보드 백엔드 (Express)
// - 설정(config) / 자격증명(credentials) 로컬 저장
// - loop-plan / loop-build 스크립트 start/stop/status
// - 로그 tail
// - Jira REST 로 claude-work 카드 상태 조회
// =============================================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4317;
const ROOT = __dirname;                       // dashboard 폴더
const SCRIPTS_DIR = path.resolve(ROOT, ".."); // loop-work 폴더 (스크립트/로그 위치)
const CONFIG_PATH = path.join(ROOT, "config.json");
const CRED_PATH = path.join(ROOT, "credentials.json");

// ----- 기본 설정값 (중립 기본값 — 대시보드에서 프로젝트별로 설정) -----
const DEFAULT_CONFIG = {
  workDir: SCRIPTS_DIR,
  repoUrl: "",                                  // 대상 GitHub repo URL
  baseBranch: "main",
  jiraSite: "",                                 // 예: your-team.atlassian.net
  projectKey: "",                               // 예: PROJ
  assigneeEmail: "",
  assigneeName: "",
  triggerText: "claude-work",
  doneStatus: "DEV COMPLETED",
  plannedLabel: "claude-planned",
  failedLabel: "claude-failed",                 // 반복 실패 카드 표시(탐지 제외)
  maxRetries: 3,                                // 연속 실패 N회 초과 시 실패 처리
  intervalSeconds: 3600,
  envPath: path.join(SCRIPTS_DIR, "work.env"),  // 대상 repo로 복사할 env 파일
  cloneBase: path.join(SCRIPTS_DIR, "repos"),   // clone 베이스 폴더
};

// ----- 파일 IO 헬퍼 -----
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, obj, mode) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
}
function getConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) };
}
function getCreds() {
  return readJson(CRED_PATH, {
    anthropicApiKey: "",
    githubToken: "",
    atlassianEmail: "",
    atlassianToken: "",
  });
}

// ----- 실행 중인 루프 프로세스 추적 -----
const loops = { plan: null, build: null }; // { proc, startedAt }

function scriptEnv() {
  const cfg = getConfig();
  const cred = getCreds();
  const env = { ...process.env };
  env.WORK_DIR = cfg.workDir;
  env.REPO_URL = cfg.repoUrl;
  env.BASE_BRANCH = cfg.baseBranch;
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = cfg.doneStatus;
  env.PLANNED_LABEL = cfg.plannedLabel;
  env.FAILED_LABEL = cfg.failedLabel || "claude-failed";
  env.MAX_RETRIES = String(cfg.maxRetries || 3);
  env.PROJECT_KEY = cfg.projectKey || "";
  env.ENV_SRC = cfg.envPath || path.join(cfg.workDir, "work.env");
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir, "repos");
  env.LOOP_INTERVAL = String(cfg.intervalSeconds || 3600);
  if (cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred.githubToken) {
    env.GH_TOKEN = cred.githubToken;
    env.GITHUB_TOKEN = cred.githubToken;
  }
  return env;
}

function startLoop(type) {
  if (loops[type] && loops[type].proc && !loops[type].proc.killed) {
    return { ok: false, message: `${type} 루프가 이미 실행 중입니다.` };
  }
  const script = path.join(SCRIPTS_DIR, `loop-${type}.sh`);
  if (!fs.existsSync(script)) {
    return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  }
  const proc = spawn("bash", [script], {
    cwd: SCRIPTS_DIR,
    env: scriptEnv(),
    detached: true,
    stdio: "ignore",
  });
  loops[type] = { proc, startedAt: new Date().toISOString(), pid: proc.pid };
  proc.on("exit", () => {
    if (loops[type] && loops[type].pid === proc.pid) loops[type] = null;
  });
  return { ok: true, pid: proc.pid };
}

function stopLoop(type) {
  const entry = loops[type];
  if (!entry || !entry.proc) return { ok: false, message: `${type} 루프가 실행 중이 아닙니다.` };
  try {
    process.kill(-entry.proc.pid, "SIGTERM"); // 프로세스 그룹 종료
  } catch {
    try { entry.proc.kill("SIGTERM"); } catch {}
  }
  loops[type] = null;
  return { ok: true };
}

function loopStatus() {
  const out = {};
  for (const t of ["plan", "build"]) {
    const e = loops[t];
    out[t] = e && e.proc && !e.proc.killed
      ? { running: true, pid: e.pid, startedAt: e.startedAt }
      : { running: false };
  }
  return out;
}

// ----- Jira REST: 카드 상태 조회 -----
async function jiraSearch(jql) {
  const cfg = getConfig();
  const cred = getCreds();
  if (!cred.atlassianEmail || !cred.atlassianToken) {
    throw new Error("Atlassian 이메일/토큰이 설정되지 않았습니다.");
  }
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  const url = `https://${cfg.jiraSite}/rest/api/3/search/jql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jql, fields: ["summary", "status", "labels", "assignee"], maxResults: 50 }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jira ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// =============================== API ROUTES ==================================
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/config", (req, res) => res.json(getConfig()));
app.post("/api/config", (req, res) => {
  const merged = { ...getConfig(), ...(req.body || {}) };
  writeJson(CONFIG_PATH, merged);
  res.json({ ok: true, config: merged });
});

// 자격증명: GET 은 값 노출 없이 설정 여부만 반환
app.get("/api/credentials", (req, res) => {
  const c = getCreds();
  res.json({
    anthropicApiKey: !!c.anthropicApiKey,
    githubToken: !!c.githubToken,
    atlassianEmail: c.atlassianEmail || "",
    atlassianToken: !!c.atlassianToken,
  });
});
app.post("/api/credentials", (req, res) => {
  const cur = getCreds();
  const b = req.body || {};
  // 빈 문자열로 덮어쓰지 않도록(마스킹된 필드 유지). 명시적으로 지우려면 "__CLEAR__".
  const apply = (k) => {
    if (b[k] === undefined) return cur[k];
    if (b[k] === "__CLEAR__") return "";
    if (b[k] === "") return cur[k];
    return b[k];
  };
  const next = {
    anthropicApiKey: apply("anthropicApiKey"),
    githubToken: apply("githubToken"),
    atlassianEmail: b.atlassianEmail !== undefined ? b.atlassianEmail : cur.atlassianEmail,
    atlassianToken: apply("atlassianToken"),
  };
  writeJson(CRED_PATH, next, 0o600);
  res.json({ ok: true });
});

app.get("/api/loops/status", (req, res) => res.json(loopStatus()));
app.post("/api/loops/:type/start", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(startLoop(type));
});
app.post("/api/loops/:type/stop", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(stopLoop(type));
});

app.get("/api/logs/:type", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  const lines = Math.min(parseInt(req.query.lines || "200", 10), 2000);
  const logPath = path.join(SCRIPTS_DIR, `loop-${type}.log`);
  if (!fs.existsSync(logPath)) return res.json({ log: "(로그 파일 없음 — 아직 실행 전)" });
  const content = fs.readFileSync(logPath, "utf8").split("\n");
  res.json({ log: content.slice(-lines).join("\n") });
});

app.get("/api/cards", async (req, res) => {
  try {
    const cfg = getConfig();
    const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
    const base = `assignee = currentUser() AND text ~ "${cfg.triggerText}"${proj}`;
    const data = await jiraSearch(`${base} ORDER BY key ASC`);
    const issues = (data.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      labels: i.fields.labels || [],
      url: `https://${cfg.jiraSite}/browse/${i.key}`,
    }));
    // 단계 분류
    const classify = (it) => {
      if (it.status === cfg.doneStatus) return "done";
      if (it.labels.includes(cfg.plannedLabel)) return "build-ready";
      return "plan-ready";
    };
    res.json({ ok: true, issues: issues.map((it) => ({ ...it, stage: classify(it) })) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// ----- work.env 모니터링/편집 -----
app.get("/api/env", (req, res) => {
  const cfg = getConfig();
  const p = cfg.envPath || path.join(cfg.workDir, "work.env");
  try {
    if (!fs.existsSync(p)) {
      return res.json({ ok: true, path: p, exists: false, content: "", mtime: null, lines: 0 });
    }
    const content = fs.readFileSync(p, "utf8");
    const stat = fs.statSync(p);
    res.json({
      ok: true,
      path: p,
      exists: true,
      content,
      mtime: stat.mtime.toISOString(),
      lines: content.split("\n").length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

app.post("/api/env", (req, res) => {
  const cfg = getConfig();
  const p = cfg.envPath || path.join(cfg.workDir, "work.env");
  const content = (req.body && req.body.content != null) ? String(req.body.content) : "";
  try {
    // 저장 전 기존 파일 백업(.bak)
    if (fs.existsSync(p)) {
      try { fs.copyFileSync(p, `${p}.bak`); } catch {}
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { mode: 0o600 });
    const stat = fs.statSync(p);
    res.json({ ok: true, path: p, mtime: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// 정적 프론트
app.use(express.static(path.join(ROOT, "public")));

app.listen(PORT, () => {
  console.log(`\n  Jira→Claude 대시보드: http://localhost:${PORT}`);
  console.log(`  스크립트 위치: ${SCRIPTS_DIR}\n`);
});
