#!/usr/bin/env node
// append-summary.js — 빌드 완료 요약을 Jira 설명 ADF '맨 아래'에 안전하게 추가한다.
//   기존 설명 노드(특히 붙여넣은 이미지 media 노드)를 그대로 보존하기 위해 markdown↔ADF
//   왕복을 거치지 않고, 설명 ADF 를 직접 GET → 요약 섹션만 append → PUT 한다.
//   재실행(rework) 시 중복 방지를 위해 기존 '완료 내역' 섹션은 제거 후 다시 추가(idempotent).
//
// 사용: node append-summary.js <summaryFile>
// env:  JIRA_SITE, ATLASSIAN_EMAIL, ATLASSIAN_TOKEN, ISSUE_KEY
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "dashboard", "lib"));

const HEADING = "완료 내역";

(async () => {
  const site = process.env.JIRA_SITE, email = process.env.ATLASSIAN_EMAIL, token = process.env.ATLASSIAN_TOKEN;
  const key = process.env.ISSUE_KEY, file = process.argv[2];
  if (!site || !email || !token || !key || !file) { console.error("append-summary: 필수 값 누락(JIRA_SITE/ATLASSIAN_EMAIL/ATLASSIAN_TOKEN/ISSUE_KEY/파일)"); process.exit(2); }

  let summary = "";
  try { summary = fs.readFileSync(file, "utf8").trim(); } catch { console.error(`append-summary: 요약 파일 없음(${file})`); process.exit(2); }
  if (!summary) { console.error("append-summary: 요약 내용이 비어 있음"); process.exit(2); }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" };
  const base = `https://${site}/rest/api/3/issue/${encodeURIComponent(key)}`;

  const get = await fetch(`${base}?fields=description`, { headers, signal: AbortSignal.timeout(20000) });
  if (!get.ok) { console.error(`append-summary: 설명 조회 실패 ${get.status}`); process.exit(1); }
  const issue = await get.json();
  const adf = (issue.fields && issue.fields.description) || { type: "doc", version: 1, content: [] };
  if (!Array.isArray(adf.content)) adf.content = [];

  // 기존 '완료 내역' 섹션 제거(heading 부터 끝까지 + 그 앞 rule). 없으면 그대로.
  const idx = adf.content.findIndex((n) => n && n.type === "heading" && lib.adfToText(n).trim() === HEADING);
  if (idx !== -1) {
    let cut = idx;
    if (cut > 0 && adf.content[cut - 1] && adf.content[cut - 1].type === "rule") cut -= 1;
    adf.content = adf.content.slice(0, cut);
  }

  // rule + heading + 요약 본문(서식 보존) append — 기존 이미지/노드는 손대지 않음
  adf.content.push({ type: "rule" });
  adf.content.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: HEADING }] });
  adf.content.push(...lib.mdToADF(summary).content);

  const put = await fetch(base, { method: "PUT", headers, body: JSON.stringify({ fields: { description: adf } }), signal: AbortSignal.timeout(20000) });
  if (!put.ok) { console.error(`append-summary: 설명 갱신 실패 ${put.status} ${(await put.text().catch(() => "")).slice(0, 200)}`); process.exit(1); }
  console.log(`append-summary: ${key} 설명 맨 아래에 '${HEADING}' 추가 완료(기존 이미지/노드 보존)`);
})().catch((e) => { console.error("append-summary:", e && e.message); process.exit(1); });
