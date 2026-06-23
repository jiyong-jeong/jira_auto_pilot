#!/usr/bin/env bash
#
# detect-cards.sh <plan|build>
# --------------------------------------------------------------------------
# 연결된 Atlassian MCP 를 통해 claude 로 Jira 를 JQL 검색하여,
# 처리 대상 카드의 key 만 한 줄에 하나씩 출력합니다. (별도 Jira 토큰 불필요)
#
#   plan  대상: 담당자=나, 내용에 claude-work 포함, 상태!=DEV COMPLETED,
#              아직 'claude-planned' 라벨이 없는 카드 (= 질문 전)
#   build 대상: 담당자=나, 내용에 claude-work 포함, 상태!=DEV COMPLETED,
#              'claude-planned' 라벨이 있는 카드 (= 질문 완료, 답변 대기/완료)
#
# 출력 예:
#   EKYB-765
#   EKYB-770
# --------------------------------------------------------------------------

set -uo pipefail

MODE="${1:-plan}"
DONE_STATUS="${DONE_STATUS:-DEV COMPLETED}"
TRIGGER_TEXT="${TRIGGER_TEXT:-claude-work}"
PLANNED_LABEL="${PLANNED_LABEL:-claude-planned}"
FAILED_LABEL="${FAILED_LABEL:-claude-failed}"   # 반복 실패 카드는 탐지에서 제외
PROJECT_KEY="${PROJECT_KEY:-}"   # 설정 시 'AND project = X' 필터 추가

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' 명령을 찾을 수 없습니다." >&2
  exit 1
fi

PROJECT_FILTER=""
if [[ -n "${PROJECT_KEY}" ]]; then
  PROJECT_FILTER=" AND project = \"${PROJECT_KEY}\""
fi

FAILED_FILTER=" AND (labels != \"${FAILED_LABEL}\" OR labels IS EMPTY)"
if [[ "${MODE}" == "plan" ]]; then
  JQL="assignee = currentUser() AND status != \"${DONE_STATUS}\" AND text ~ \"${TRIGGER_TEXT}\" AND (labels != \"${PLANNED_LABEL}\" OR labels IS EMPTY)${FAILED_FILTER}${PROJECT_FILTER}"
elif [[ "${MODE}" == "build" ]]; then
  JQL="assignee = currentUser() AND status != \"${DONE_STATUS}\" AND text ~ \"${TRIGGER_TEXT}\" AND labels = \"${PLANNED_LABEL}\"${FAILED_FILTER}${PROJECT_FILTER}"
else
  echo "Usage: $0 <plan|build>" >&2
  exit 1
fi

# ===== REST 우선 탐지 (대시보드 백엔드가 떠 있으면 결정적·저비용) =====
# DASHBOARD_URL 이 주입되어 있고 curl 이 있으면 /api/detect/<mode> 로 조회.
# 응답이 없거나 실패하면 아래 claude(+MCP) 탐지로 폴백한다.
if [[ -n "${DASHBOARD_URL:-}" ]] && command -v curl >/dev/null 2>&1; then
  REST_RESP="$(curl -fsS --max-time 20 "${DASHBOARD_URL}/api/detect/${MODE}" 2>/dev/null || true)"
  if [[ -n "${REST_RESP}" ]]; then
    echo "${REST_RESP}" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | sort -u
    exit 0
  fi
  echo "WARN: REST 탐지 실패 → claude 폴백" >&2
fi

PROMPT="Jira 에서 다음 JQL 로 이슈를 검색하세요:
${JQL}

검색된 이슈들의 key 만 한 줄에 하나씩 출력하세요.
설명, 마크다운, 코드블록, 그 외 어떤 텍스트도 출력하지 마세요. 오직 key 들만 출력하세요.
검색 결과가 없으면 'NONE' 한 줄만 출력하세요."

# claude 출력에서 이슈키(PROJ-숫자) 패턴만 추출 (그 외 잡텍스트 제거)
claude -p "${PROMPT}" 2>/dev/null | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | sort -u
