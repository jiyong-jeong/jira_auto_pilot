// =============================================================================
// lib.js — server.js 의 순수 로직 + 프로젝트 스토어(파일 경로 주입형). 단위 테스트 대상.
// =============================================================================
const fs = require("fs");

const DEFAULT_CREDS = { anthropicApiKey: "", githubToken: "", atlassianEmail: "", atlassianToken: "", slackWebhookUrl: "" };

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };
const writeJson = (p, obj, mode) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proj";
}

// 카드↔repo 매핑 라벨 접두사 (Jira 라벨 안전 문자만 사용: repo_<name>)
const REPO_LABEL_PREFIX = "repo_";
function repoNameFromUrl(url) {
  return slugify(String(url || "").replace(/\.git$/, "").split("/").filter(Boolean).pop() || "repo");
}
// 프로젝트의 repo 목록 정규화: repos 배열 우선, 없으면 레거시 repoUrl 1개로 변환
function normalizeRepos(p) {
  if (Array.isArray(p.repos) && p.repos.length) {
    return p.repos.filter((r) => r && r.url).map((r) => ({
      name: r.name || repoNameFromUrl(r.url),
      url: r.url,
      baseBranch: r.baseBranch || p.baseBranch || "main",
    }));
  }
  if (p.repoUrl) return [{ name: repoNameFromUrl(p.repoUrl), url: p.repoUrl, baseBranch: p.baseBranch || "main" }];
  return [];
}
// 카드 라벨로 대상 repo 결정: repo_<name> 라벨과 매칭. 없으면 첫 repo(기본).
function cardRepos(p, labels) {
  const repos = normalizeRepos(p);
  const names = (labels || []).filter((l) => l.indexOf(REPO_LABEL_PREFIX) === 0).map((l) => l.slice(REPO_LABEL_PREFIX.length));
  const sel = repos.filter((r) => names.includes(r.name));
  return sel.length ? sel : (repos.length ? [repos[0]] : []);
}

function triggerClause(cfg) {
  return cfg.triggerMode === "text" ? `text ~ "${cfg.triggerText}"` : `labels = "${cfg.triggerLabel}"`;
}

function detectJql(mode, cfg) {
  const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
  const failed = ` AND (labels != "${cfg.failedLabel}" OR labels IS EMPTY)`;
  // 완료 제외: 상태 카테고리 Done + 설정한 완료 상태명(doneStatus) 둘 다. (워크플로마다 완료가
  // 'Done 카테고리'일 수도, 'DEV COMPLETED' 처럼 카테고리가 다른 커스텀 상태일 수도 있어 둘 다 제외)
  const doneName = cfg.doneStatus ? ` AND status != "${cfg.doneStatus}"` : "";
  const prLabel = cfg.prOpenLabel || "claude-pr";
  const base = `assignee = currentUser() AND statusCategory != Done${doneName} AND ${triggerClause(cfg)}`;
  if (mode === "plan") return `${base} AND (labels != "${cfg.plannedLabel}" OR labels IS EMPTY)${failed}${proj}`;
  // build: PR 을 이미 올린(claude-pr) 카드는 병합 대기 상태이므로 재빌드 대상에서 제외
  return `${base} AND labels = "${cfg.plannedLabel}" AND labels = "${cfg.answeredLabel}" AND (labels != "${prLabel}" OR labels IS EMPTY)${failed}${proj}`;
}

function adfToText(node) {
  if (!node) return "";
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return "@" + (node.attrs && node.attrs.text ? node.attrs.text.replace(/^@/, "") : "");
  if (node.type === "emoji") return (node.attrs && (node.attrs.shortName || node.attrs.text)) || "";
  const inner = node.content ? adfToText(node.content) : "";
  if (node.type === "listItem") return "• " + inner.replace(/\n+$/, "") + "\n";
  if (node.type === "blockquote") { const t = inner.replace(/\n+$/, ""); return t.split("\n").map((l) => "> " + l).join("\n") + "\n"; }
  if (["paragraph", "heading", "codeBlock", "rule", "panel"].indexOf(node.type) !== -1) return inner + "\n";
  return inner;
}

function toADF(text) {
  return { type: "doc", version: 1, content: String(text).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] })) };
}

function buildReplyADF(body, replyTo) {
  const content = [];
  if (replyTo && replyTo.snippet) {
    const q = String(replyTo.snippet).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] }));
    content.push({ type: "blockquote", content: q.length ? q : [{ type: "paragraph", content: [] }] });
  }
  String(body).split("\n").forEach((ln, idx) => {
    const para = { type: "paragraph", content: [] };
    if (idx === 0 && replyTo && replyTo.accountId) {
      para.content.push({ type: "mention", attrs: { id: replyTo.accountId, text: "@" + (replyTo.author || "user") } });
      para.content.push({ type: "text", text: " " });
    }
    if (ln) para.content.push({ type: "text", text: ln });
    content.push(para);
  });
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

function maskCreds(c) {
  return {
    anthropicApiKey: !!c.anthropicApiKey, githubToken: !!c.githubToken,
    atlassianEmail: c.atlassianEmail || "", atlassianToken: !!c.atlassianToken, slackWebhookUrl: !!c.slackWebhookUrl,
  };
}

function applyCreds(cur, b) {
  const apply = (k) => (b[k] === undefined ? cur[k] : b[k] === "__CLEAR__" ? "" : b[k] === "" ? cur[k] : b[k]);
  return {
    anthropicApiKey: apply("anthropicApiKey"),
    githubToken: apply("githubToken"),
    atlassianEmail: b.atlassianEmail !== undefined ? b.atlassianEmail : cur.atlassianEmail,
    atlassianToken: apply("atlassianToken"),
    slackWebhookUrl: apply("slackWebhookUrl"),
  };
}

// 프로젝트 스토어(파일 경로 주입형) — 단위 테스트는 임시 경로로 생성해 검증한다.
function createStore({ projectsPath, credsPath, configPath, credPath, defaultConfig }) {
  function migrateIfNeeded() {
    if (readJson(projectsPath, null)) return false;
    const legacy = configPath && readJson(configPath, null);
    if (legacy) {
      const id = slugify(legacy.projectKey || "default");
      const name = legacy.projectKey || "기본 프로젝트";
      writeJson(projectsPath, { projects: [{ id, name, ...legacy }] });
      const lc = credPath && readJson(credPath, null);
      if (lc) writeJson(credsPath, { [id]: { ...DEFAULT_CREDS, ...lc } }, 0o600);
      return id;
    }
    writeJson(projectsPath, { projects: [] });
    return false;
  }
  function listProjects() {
    const raw = readJson(projectsPath, { projects: [] });
    return (raw.projects || []).map((p) => { const m = { ...defaultConfig, ...p }; return { ...m, repos: normalizeRepos(m) }; });
  }
  function getProject(id) { return listProjects().find((p) => p.id === id) || null; }
  function defaultProjectId() { const l = listProjects(); return l.length ? l[0].id : null; }
  function saveProject(p) {
    const list = listProjects();
    let id = p.id || slugify(p.name || p.projectKey || "proj");
    if (!p.id) { const base = id; let n = 2; while (list.some((x) => x.id === id)) id = `${base}-${n++}`; }
    const idx = list.findIndex((x) => x.id === id);
    const merged = idx >= 0 ? { ...list[idx], ...p, id } : { ...defaultConfig, ...p, id };
    if (idx >= 0) list[idx] = merged; else list.push(merged);
    writeJson(projectsPath, { projects: list });
    return merged;
  }
  function removeProject(id) {
    writeJson(projectsPath, { projects: listProjects().filter((p) => p.id !== id) });
    const all = readJson(credsPath, {});
    if (all[id]) { delete all[id]; writeJson(credsPath, all, 0o600); }
  }
  function getProjectCreds(id) { const all = readJson(credsPath, {}); return { ...DEFAULT_CREDS, ...(all[id] || {}) }; }
  function setProjectCreds(id, next) { const all = readJson(credsPath, {}); all[id] = { ...DEFAULT_CREDS, ...(all[id] || {}), ...next }; writeJson(credsPath, all, 0o600); }
  return { migrateIfNeeded, listProjects, getProject, defaultProjectId, saveProject, removeProject, getProjectCreds, setProjectCreds };
}

module.exports = {
  DEFAULT_CREDS, readJson, writeJson, slugify, triggerClause, detectJql,
  adfToText, toADF, buildReplyADF, maskCreds, applyCreds, createStore,
  REPO_LABEL_PREFIX, repoNameFromUrl, normalizeRepos, cardRepos,
};
