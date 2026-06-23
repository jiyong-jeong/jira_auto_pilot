#!/usr/bin/env bash
#
# loop-plan.sh
# --------------------------------------------------------------------------
# 한 시간(기본)마다 plan 대상 카드를 탐지하여 카드별로 병렬로 plan 을 실행합니다.
# - plan 대상: claude-work 포함 + 담당자=나 + 상태!=DEV COMPLETED + claude-planned 라벨 없음
# - 각 카드는 <repo이름>-<카드키> 디렉토리에서 독립 실행 (병렬)
#
# 실행:
#   ./loop-plan.sh                 # 포그라운드 (Ctrl+C 로 종료)
#   nohup ./loop-plan.sh &         # 백그라운드
#   LOOP_INTERVAL=1800 ./loop-plan.sh   # 주기를 30분으로 변경
# --------------------------------------------------------------------------

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${LOOP_INTERVAL:-3600}"   # 기본 1시간
MAX_PARALLEL="${MAX_PARALLEL:-3}"   # 동시에 처리할 카드 수 상한
LOG="${HERE}/loop-plan.log"

echo "[$(date '+%F %T')] loop-plan 시작 (interval=${INTERVAL}s, max_parallel=${MAX_PARALLEL})${RUN_ONCE:+ [즉시 1회 실행]}" | tee -a "${LOG}"

while true; do
  echo "[$(date '+%F %T')] plan 대상 탐지..." | tee -a "${LOG}"
  keys="$("${HERE}/detect-cards.sh" plan 2>>"${LOG}" || true)"

  if [[ -n "${keys}" ]]; then
    while IFS= read -r key; do
      [[ -z "${key}" ]] && continue
      # 동시 실행 상한 유지: 실행 중 작업이 상한 미만이 될 때까지 대기
      while (( $(jobs -rp | wc -l) >= MAX_PARALLEL )); do sleep 1; done
      echo "[$(date '+%F %T')] PLAN 실행: ${key} (동시 상한 ${MAX_PARALLEL})" | tee -a "${LOG}"
      # 카드별 병렬 실행 (각자 <repo이름>-<key> 디렉토리)
      "${HERE}/run-jira-claude.sh" "${key}" plan >>"${LOG}" 2>&1 &
    done <<< "${keys}"
    wait   # 이번 주기의 모든 plan 작업 완료 대기
  else
    echo "[$(date '+%F %T')] plan 대상 없음" | tee -a "${LOG}"
  fi

  # 즉시 실행 모드: 1회 처리 후 종료
  if [[ -n "${RUN_ONCE:-}" ]]; then
    echo "[$(date '+%F %T')] RUN_ONCE: plan 1회 실행 완료, 종료" | tee -a "${LOG}"
    break
  fi

  # 다음 정시(인터벌 경계)까지 정렬해서 대기
  now=$(date +%s)
  next=$(( (now / INTERVAL + 1) * INTERVAL ))
  wait_s=$(( next - now ))
  echo "[$(date '+%F %T')] 다음 실행까지 ${wait_s}s 대기 (정시 정렬)" | tee -a "${LOG}"
  sleep "${wait_s}"
done
