#!/usr/bin/env bash
#
# run-jira-claude.sh
# --------------------------------------------------------------------------
# Jira 카드 기반으로 임의의 GitHub repo 개발을 반자동으로 진행하는 범용 스크립트.
# 카드별로 독립 디렉토리(<repo이름>-<카드키>)에서 동작하므로 병렬 실행이 가능합니다.
# 모든 설정은 환경변수로 주입합니다(대시보드가 주입하거나, 수동 실행 시 export).
#
# 흐름:
#   1) CLONE_BASE 아래에 <repo이름>-<카드키> 로 clone (없으면)
#   2) BASE_BRANCH 로 이동 + 최신화
#   3) env 파일(ENV_SRC, 기본 work.env)을 clone 된 디렉토리로 복사
#   4) clone 디렉토리로 cd
#   5) claude 실행
#        - plan  단계: 카드 검토 → 질문 코멘트 작성 → PLANNED_LABEL 라벨 추가
#        - build 단계: 답변 반영 개발 → 브랜치/커밋/푸시 → BASE_BRANCH 로 PR
#                      → 카드 설명의 트리거 텍스트 위에 완료 요약 기입 → DONE_STATUS 전환
#
# 사용법:
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-claude.sh <ISSUE-KEY> plan
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-claude.sh <ISSUE-KEY> build
# --------------------------------------------------------------------------

set -euo pipefail

# 스크립트가 위치한 폴더 (기본 작업 폴더로 사용)
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ===== 설정 (환경변수로 주입 가능, 없으면 기본값) =====
WORK_DIR="${WORK_DIR:-${SELF_DIR}}"
REPO_URL="${REPO_URL:-}"                       # 필수: 대상 GitHub repo URL
ENV_SRC="${ENV_SRC:-${WORK_DIR}/work.env}"     # 대상 repo로 복사할 env 파일
CLONE_BASE="${CLONE_BASE:-${WORK_DIR}/repos}"  # clone 들이 모이는 베이스 폴더
BASE_BRANCH="${BASE_BRANCH:-main}"
ASSIGNEE_EMAIL="${ASSIGNEE_EMAIL:-}"
ASSIGNEE_NAME="${ASSIGNEE_NAME:-담당자}"
TRIGGER_TEXT="${TRIGGER_TEXT:-claude-work}"
DONE_STATUS="${DONE_STATUS:-DEV COMPLETED}"
PLANNED_LABEL="${PLANNED_LABEL:-claude-planned}"
FAILED_LABEL="${FAILED_LABEL:-claude-failed}"   # 반복 실패 카드 표시(탐지 제외)
MAX_RETRIES="${MAX_RETRIES:-3}"                 # 연속 실패 N회 초과 시 실패 처리

if [[ -z "${REPO_URL}" ]]; then
  echo "ERROR: REPO_URL 이 설정되지 않았습니다. 환경변수로 대상 repo URL 을 지정하세요." >&2
  exit 1
fi

# repo 디렉토리/이름은 REPO_URL 기준으로 자동 도출 (어떤 repo든 지원)
REPO_NAME="$(basename "${REPO_URL%.git}")"
ENV_NAME="$(basename "${ENV_SRC}")"

# ===== 인자 파싱 =====
ISSUE_KEY="${1:-}"
PHASE="${2:-plan}"   # plan | build

if [[ -z "${ISSUE_KEY}" ]]; then
  echo "Usage: $0 <JIRA-ISSUE-KEY> [plan|build]" >&2
  exit 1
fi
if [[ "${PHASE}" != "plan" && "${PHASE}" != "build" ]]; then
  echo "ERROR: phase 는 'plan' 또는 'build' 여야 합니다 (입력: ${PHASE})" >&2
  exit 1
fi

# ===== 카드별 디렉토리 (병렬 실행용) =====
REPO_DIR="${CLONE_BASE}/${REPO_NAME}-${ISSUE_KEY}"
ENV_DEST="${REPO_DIR}/${ENV_NAME}"

# ===== 필수 도구 확인 =====
for cmd in git claude; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: '${cmd}' 명령을 찾을 수 없습니다. 설치/PATH 를 확인하세요." >&2
    exit 1
  fi
done
if [[ "${PHASE}" == "build" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: PR 생성을 위해 'gh' (GitHub CLI) 가 필요합니다. 'brew install gh && gh auth login'" >&2
  exit 1
fi

# ===== 1) clone (없으면) =====
mkdir -p "${CLONE_BASE}"
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo ">> [${ISSUE_KEY}] Cloning ${REPO_URL} -> ${REPO_DIR}"
  git clone "${REPO_URL}" "${REPO_DIR}"
else
  echo ">> [${ISSUE_KEY}] 이미 clone 됨: ${REPO_DIR}"
fi

# ===== 2) clone 디렉토리 클린업 + base 브랜치 정렬 =====
# 카드별 dir 재사용 시 이전 작업의 잔여 변경/추적되지 않은 파일/꼬인 브랜치 상태가
# checkout 을 막지 않도록, fetch 후 강제로 정리하고 base 를 origin 에 맞춘다.
cd "${REPO_DIR}"
echo ">> [${ISSUE_KEY}] fetch & 클린업 & checkout ${BASE_BRANCH}"
git fetch origin --prune
git reset --hard
git clean -fd
git checkout "${BASE_BRANCH}"
git reset --hard "origin/${BASE_BRANCH}"

# ===== 3) env 파일 복사 =====
if [[ -f "${ENV_SRC}" ]]; then
  cp "${ENV_SRC}" "${ENV_DEST}"
  echo ">> [${ISSUE_KEY}] env 복사: ${ENV_SRC} -> ${ENV_DEST}"
else
  echo ">> [${ISSUE_KEY}] WARN: env 파일 없음: ${ENV_SRC} (건너뜀)"
fi

# ===== 4) clone 디렉토리로 이동 (이미 cd 됨) =====
echo ">> [${ISSUE_KEY}] 작업 디렉토리: $(pwd)"

# ===== 5) claude 실행 (+ 실패 재시도/백오프) =====
if [[ "${PHASE}" == "plan" ]]; then
  echo ">> [${ISSUE_KEY}] [PLAN] 카드 검토 + 질문 코멘트 작성"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 작업을 준비 중입니다.

먼저 확인:
1. 이 이슈가 ${ASSIGNEE_NAME} (${ASSIGNEE_EMAIL}) 에게 할당되어 있는지 확인하세요.
2. 이슈의 설명/내부 컨텐츠에 '${TRIGGER_TEXT}' 라는 텍스트가 포함되어 있는지 확인하세요.
3. 이슈의 현재 상태가 '${DONE_STATUS}' 가 아닌지 확인하세요.
   위 조건 중 하나라도 충족하지 않으면, 아무 작업도 하지 말고 이유를 출력하고 종료하세요.

조건 충족 시:
- 현재 코드베이스(${REPO_NAME}, ${BASE_BRANCH} 브랜치)를 살펴보고, 이슈가 요구하는 구현 내용을 검토하세요.
- 아직 코드를 작성하지 마세요.
- 구현 전에 명확히 해야 할 질문들을 정리해, Jira 이슈 ${ISSUE_KEY} 에 코멘트로 작성하세요.
  코멘트는 담당자(${ASSIGNEE_NAME})를 멘션하고, 답변하기 쉽게 번호를 매겨 질문하세요.
- 질문이 없다면, '질문 없음 — 구현 준비 완료' 라는 코멘트를 남기세요.
- 코멘트 작성에 성공한 뒤, 이 이슈에 '${PLANNED_LABEL}' 라벨을 추가하세요.
  (이 라벨은 build 루프가 이 카드를 인식하고, plan 루프가 중복 처리하지 않도록 하는 표시입니다.)"
else
  # ===== 멱등성 가드: 이미 이 이슈로 만든 PR/원격 브랜치가 있으면 스킵 =====
  # build 중간 실패 후 재시도 시 중복 브랜치/PR 생성을 방지한다.
  EXISTING_BRANCH="$(git ls-remote --heads origin "feature/${ISSUE_KEY}-*" "feature/${ISSUE_KEY}" 2>/dev/null \
    | awk '{print $2}' | sed 's#refs/heads/##' | head -n1 || true)"
  EXISTING_PR=""
  if command -v gh >/dev/null 2>&1; then
    EXISTING_PR="$(gh pr list --state open --search "${ISSUE_KEY}" \
      --json url,headRefName --jq '.[0].url' 2>/dev/null || true)"
  fi
  if [[ -n "${EXISTING_BRANCH}" || -n "${EXISTING_PR}" ]]; then
    echo "SKIP: 이미 처리됨 — 이슈 ${ISSUE_KEY} 의 브랜치(${EXISTING_BRANCH:-없음}) / PR(${EXISTING_PR:-없음}) 존재. 중복 생성 방지를 위해 종료."
    echo ">> [${ISSUE_KEY}] 완료 (phase=${PHASE}, skipped=idempotent)"
    exit 0
  fi

  echo ">> [${ISSUE_KEY}] [BUILD] 답변 반영 + 개발 + PR"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 를 ${REPO_NAME} 코드베이스에서 구현합니다. 작업 디렉토리는 현재 디렉토리입니다.

1. Jira 이슈 ${ISSUE_KEY} 의 설명과 '모든 코멘트'(특히 담당자 ${ASSIGNEE_NAME} 의 답변)를 읽으세요.
2. 담당자가 앞선 plan 단계 질문에 '아직 답변하지 않았다면', 어떤 코드 변경/커밋/PR도 하지 말고
   정확히 'SKIP: awaiting answers' 한 줄만 출력하고 종료하세요. (다음 주기에 다시 시도됩니다.)
3. 답변이 있으면 그 내용을 반영해 요구된 작업을 구현하세요.
4. 구현 후:
   - Jira 이슈 키를 반영한 새 git 브랜치를 만드세요 (예: feature/${ISSUE_KEY}-<짧은-설명>).
   - 명확한 메시지로 커밋하세요. 커밋 메시지 '본문 하단'에 '${ISSUE_KEY}' 를 명시하세요.
   - 'origin' 으로 브랜치를 push 하세요.
   - gh CLI 로 '${BASE_BRANCH}' 브랜치를 target 으로 하는 Pull Request 를 생성하고 PR URL 을 출력하세요.
   - (보안) env 파일(${ENV_DEST} 또는 .env)은 절대 커밋/푸시하지 마세요. 커밋 전 git status 로 확인하고,
     포함될 위험이 있으면 .gitignore 에 추가하세요.
5. PR 생성까지 성공하면 마무리로:
   a) 이슈 ${ISSUE_KEY} 설명에서 '${TRIGGER_TEXT}' 텍스트 '바로 위'에 완료 요약을 추가하세요.
      요약에는 변경 내용 요약, PR URL, 브랜치명, 완료 일시를 포함하세요. ('${TRIGGER_TEXT}' 텍스트 자체는 유지)
   b) 이슈 상태를 '${DONE_STATUS}' 로 전환하세요. 가능한 transition 을 먼저 조회한 뒤 전환하고,
      전환이 불가능하면 사유를 출력하세요.
완료 후 결과(브랜치/PR URL/상태) 요약을 출력하세요."
fi

# ===== 실행 + 실패 재시도/백오프 처리 =====
# claude 가 0이 아닌 코드로 종료하면 실패로 보고 카드별 실패 카운터를 증가시킨다.
# (build 의 'SKIP: awaiting answers' 는 정상 종료(0)이므로 실패로 집계되지 않는다.)
STATE_DIR="${CLONE_BASE}/.state"
FAIL_FILE="${STATE_DIR}/${ISSUE_KEY}.fail"
CLAUDE_OUT="${STATE_DIR}/${ISSUE_KEY}.${PHASE}.out"
mkdir -p "${STATE_DIR}"

if claude -p "${PROMPT}" 2>&1 | tee "${CLAUDE_OUT}"; then
  rm -f "${FAIL_FILE}"
  echo ">> [${ISSUE_KEY}] 완료 (phase=${PHASE})"
else
  count=$(( $(cat "${FAIL_FILE}" 2>/dev/null || echo 0) + 1 ))
  echo "${count}" > "${FAIL_FILE}"
  echo ">> [${ISSUE_KEY}] 실패 (phase=${PHASE}, ${count}/${MAX_RETRIES})" >&2
  if (( count >= MAX_RETRIES )); then
    echo ">> [${ISSUE_KEY}] 최대 재시도(${MAX_RETRIES}) 초과 → '${FAILED_LABEL}' 라벨 + 실패 코멘트" >&2
    ERR_TAIL="$(tail -n 25 "${CLAUDE_OUT}" 2>/dev/null || true)"
    claude -p "Jira 이슈 ${ISSUE_KEY} 의 자동화 처리가 ${MAX_RETRIES}회 연속 실패했습니다.
다음만 수행하고, 코드 변경/커밋/PR 은 절대 하지 마세요:
1) 이슈 ${ISSUE_KEY} 에 '${FAILED_LABEL}' 라벨을 추가하세요.
2) 담당자(${ASSIGNEE_NAME})를 멘션해, 자동화가 반복 실패하여 수동 확인이 필요하다는 코멘트를 남기세요.
   아래 마지막 오류 로그 요약을 코멘트에 포함하세요:
---
${ERR_TAIL}
---" || true
  fi
  exit 1
fi
