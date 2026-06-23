#!/usr/bin/env bash
#
# loop-build.sh
# --------------------------------------------------------------------------
# 한 시간(기본)마다 build 대상 카드를 탐지하여 카드별로 병렬로 build 를 실행합니다.
# - build 대상: claude-work 포함 + 담당자=나 + 상태!=DEV COMPLETED + claude-planned 라벨 있음
# - 담당자 답변이 아직 없으면 해당 카드는 'SKIP' 되고 다음 주기에 재시도됩니다.
# - 완료되면 카드가 DEV COMPLETED 로 전환되어 다음 주기부터 탐지에서 제외됩니다.
# - 각 카드는 <repo이름>-<카드키> 디렉토리에서 독립 실행 (병렬)
#
# 실행:
#   ./loop-build.sh                # 포그라운드 (Ctrl+C 로 종료)
#   nohup ./loop-build.sh &        # 백그라운드
#   LOOP_INTERVAL=1800 ./loop-build.sh   # 주기를 30분으로 변경
# --------------------------------------------------------------------------

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${LOOP_INTERVAL:-3600}"   # 기본 1시간
LOG="${HERE}/loop-build.log"

echo "[$(date '+%F %T')] loop-build 시작 (interval=${INTERVAL}s)" | tee -a "${LOG}"

while true; do
  echo "[$(date '+%F %T')] build 대상 탐지..." | tee -a "${LOG}"
  keys="$("${HERE}/detect-cards.sh" build 2>>"${LOG}" || true)"

  if [[ -n "${keys}" ]]; then
    while IFS= read -r key; do
      [[ -z "${key}" ]] && continue
      echo "[$(date '+%F %T')] BUILD 실행: ${key}" | tee -a "${LOG}"
      # 카드별 병렬 실행 (각자 <repo이름>-<key> 디렉토리)
      "${HERE}/run-jira-claude.sh" "${key}" build >>"${LOG}" 2>&1 &
    done <<< "${keys}"
    wait   # 이번 주기의 모든 build 작업 완료 대기
  else
    echo "[$(date '+%F %T')] build 대상 없음" | tee -a "${LOG}"
  fi

  # 다음 정시(인터벌 경계)까지 정렬해서 대기
  now=$(date +%s)
  next=$(( (now / INTERVAL + 1) * INTERVAL ))
  wait_s=$(( next - now ))
  echo "[$(date '+%F %T')] 다음 실행까지 ${wait_s}s 대기 (정시 정렬)" | tee -a "${LOG}"
  sleep "${wait_s}"
done
