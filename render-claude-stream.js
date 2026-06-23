#!/usr/bin/env node
// render-claude-stream.js
// --------------------------------------------------------------------------
// claude -p --output-format stream-json --verbose 의 JSONL(stdin)을 받아:
//   1) 사람이 읽기 좋은 전사(도구 호출/메시지/결과)를 arg1 로그 파일에 append(라이브)
//   2) 최종 결과 텍스트를 stdout 으로 출력(상위 스크립트의 SKIP/PR 파싱용)
// exit: 결과가 에러(is_error)면 1, 아니면 0.
// --------------------------------------------------------------------------
const fs = require("fs");
const readline = require("readline");

const logPath = process.argv[2];
const out = logPath ? fs.createWriteStream(logPath, { flags: "a" }) : null;
const w = (s) => { if (out) out.write(s + "\n"); };
const trunc = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + " …(생략)" : s; };
const ts = () => new Date().toISOString().slice(11, 19);

let finalText = "";
let isError = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  try {
    if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text && c.text.trim()) w(`[${ts()}] 💬 ${trunc(c.text.trim(), 2000)}`);
        else if (c.type === "tool_use") w(`[${ts()}] 🔧 ${c.name} ${trunc(JSON.stringify(c.input || {}), 600)}`);
      }
    } else if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_result") {
          const t = Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("") : (c.content || "");
          w(`[${ts()}]   ↳ ${trunc(t, 800)}`);
        }
      }
    } else if (ev.type === "result") {
      isError = !!ev.is_error;
      finalText = ev.result || "";
      w(`[${ts()}] ${isError ? "❌" : "✅"} 결과: ${trunc(finalText, 2000)}`);
    }
  } catch { /* 개별 이벤트 렌더 실패는 무시 */ }
});
rl.on("close", () => {
  if (finalText) process.stdout.write(finalText + "\n");
  const done = () => process.exit(isError ? 1 : 0);
  if (out) out.end(done); else done();
});
