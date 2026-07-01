#!/usr/bin/env bash
#
# loop-review.sh
# --------------------------------------------------------------------------
# 정해진 주기(기본 1시간)마다 review 사이클을 실행한다. 한 사이클에서 run-cycle.js 가
# 등록된 '모든 프로젝트'를 순회하며, 자동화가 올린 build PR(claude-pr 카드의 열린 PR)을
# 탐지 → Claude 리뷰(run-review.sh)로 점검한다.
# - 미승인 PR 은 매 주기 최신 코멘트를 반영해 재리뷰한다.
# - 리뷰어(Claude)가 문제없다고 판단하면 고유 승인 마커 코멘트를 남기고, 이후 주기부터 스킵한다.
#
# 실행:
#   ./loop-review.sh                        # 포그라운드
#   REVIEW_LOOP_INTERVAL=1800 ./loop-review.sh   # 주기 30분
#   RUN_ONCE=1 ./loop-review.sh             # 즉시 1회만 실행 후 종료
# --------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${REVIEW_LOOP_INTERVAL:-${LOOP_INTERVAL:-3600}}"
LOG="${HERE}/loop-review.log"

echo "[$(date '+%F %T')] loop-review 시작 (interval=${INTERVAL}s, 전 프로젝트 순회)${RUN_ONCE:+ [즉시 1회 실행]}" | tee -a "${LOG}"

while true; do
  echo "[$(date '+%F %T')] review 사이클 시작 (모든 프로젝트)" | tee -a "${LOG}"
  node "${HERE}/run-cycle.js" review >>"${LOG}" 2>&1 || echo "[$(date '+%F %T')] run-cycle(review) 오류" | tee -a "${LOG}"

  if [[ -n "${RUN_ONCE:-}" ]]; then
    echo "[$(date '+%F %T')] RUN_ONCE: review 1회 실행 완료, 종료" | tee -a "${LOG}"
    break
  fi

  now=$(date +%s)
  next=$(( (now / INTERVAL + 1) * INTERVAL ))
  wait_s=$(( next - now ))
  echo "[$(date '+%F %T')] 다음 실행까지 ${wait_s}s 대기 (정시 정렬)" | tee -a "${LOG}"
  sleep "${wait_s}"
done
