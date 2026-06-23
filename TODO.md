# TODO — 자동화 루프 보강 작업

자동화 루프를 더 안정적이고 운영 가능하게 만들기 위한 개선 항목입니다.
우선순위 순으로 정리되어 있으며, 각 항목은 완료 기준(AC)과 영향 파일을 포함합니다.

> ⚠️ **완료 정의 (Definition of Done) — 모든 항목 공통**
> 어떤 항목이든 구현이 끝나면 반드시:
> 1. `DOCUMENTATION.md`(및 필요 시 `README.md`, `LOOP-GUIDE.md`)를 **변경 내용에 맞게 동기화**한다.
> 2. 이 `TODO.md`의 해당 체크박스를 `[x]`로 갱신하고, 변경 요약/PR 링크를 항목 아래 한 줄로 남긴다.
> 3. 문서 동기화가 안 된 변경은 "완료"로 간주하지 않는다.
> (이 규칙은 `CLAUDE.md`에도 명시되어, 개발을 수행하는 Claude가 자동으로 따릅니다.)

---

## 높은 우선순위 — 안정성·정확성

- [x] **1. 멱등성 가드 (중복 PR/브랜치 방지)**
  - 내용: build 중간 실패(예: 상태 전환 실패) 후 재시도 시 동일 이슈에 중복 브랜치/PR이 생기지 않도록 가드.
  - AC: build 시작 시 해당 이슈 키로 열린 PR/원격 브랜치가 있으면 새로 만들지 않고 기존 것을 재사용하거나 스킵.
  - 영향: `run-jira-claude.sh` (build 프롬프트/사전 점검)
  → (완료 2026-06-23) build 단계 claude 실행 전 `git ls-remote feature/<KEY>-*` + `gh pr list --search <KEY>` 점검, 존재 시 `SKIP: 이미 처리됨` 출력 후 종료.

- [ ] **2. 실패 처리·재시도 정책**
  - 내용: 실패한 카드가 매 주기 무한 재시도되지 않도록 처리.
  - AC: 실패 시 `claude-failed` 라벨 부여 + 실패 사유를 카드 코멘트로 기록 + N회 초과 시 탐지에서 제외(백오프).
  - 영향: `run-jira-claude.sh`, `detect-cards.sh`(JQL에 `claude-failed` 제외)

- [ ] **3. clone 디렉토리 클린업**
  - 내용: 카드별 dir 재사용 시 이전 잔여 변경/브랜치로 checkout이 꼬이는 문제 방지.
  - AC: build 시작 시 `git reset --hard` + `git clean -fd` 후 base 브랜치로 정렬.
  - 영향: `run-jira-claude.sh`

- [ ] **4. env 유출 방지 강화**
  - 내용: `work.env`가 대상 repo로 커밋되는 사고를 구조적으로 차단.
  - AC: env 복사 직후 clone의 `.git/info/exclude`에 env 파일명을 자동 추가(프롬프트 의존 제거).
  - 영향: `run-jira-claude.sh`

- [ ] **5. 탐지 로직 REST 전환**
  - 내용: detect를 `claude` 호출 대신 백엔드 Jira REST로 전환(빠르고 결정적, 비용 절감).
  - AC: 대시보드/루프가 Jira REST로 plan/build 후보를 조회. claude 기반 detect는 폴백으로만.
  - 영향: `dashboard/server.js`(`/api/detect`), 루프가 백엔드/REST 사용

---

## 중간 우선순위 — 운영 편의

- [ ] **6. 알림(Notification)**
  - 내용: PR 생성/완료/실패 시 Slack(또는 이메일) 알림.
  - AC: 설정한 웹훅으로 이벤트별 메시지 발송. 미설정 시 무시.
  - 영향: `run-jira-claude.sh` 또는 백엔드, 설정 추가

- [ ] **7. 답변 감지 명시적 신호**
  - 내용: "담당자 답변 여부"를 claude 판단에만 의존하지 않도록 명시적 신호 도입.
  - AC: 담당자가 다는 `claude-answered` 라벨 또는 "bot 질문 이후 담당자 코멘트 존재"를 build 진입 조건으로 사용.
  - 영향: `detect-cards.sh`(build JQL), `run-jira-claude.sh`

- [ ] **8. 루프 영속성·상태 일관성**
  - 내용: 재부팅/크래시 후 자동 재시작, 대시보드 상태와 실제 프로세스 일치.
  - AC: launchd/pm2 등록 가이드 + pid를 디스크(pidfile)에 기록해 백엔드 재시작 후에도 상태 정확.
  - 영향: `dashboard/server.js`, 운영 문서

- [ ] **9. 병렬 처리 상한**
  - 내용: 매칭 카드가 많을 때 claude 프로세스 과다 생성 방지.
  - AC: 동시에 처리하는 카드 수 상한(예: 3) 적용.
  - 영향: `loop-plan.sh`, `loop-build.sh`

---

## 낮은 우선순위 — 품질 향상

- [ ] **10. PR 품질**
  - 내용: 테스트/린트 통과 후 PR, 리뷰어·라벨 지정, Jira↔PR 양방향 링크(remote link).
  - AC: 프로젝트별 test/lint 명령 설정 시 PR 전에 실행, 실패하면 PR 보류. PR에 Jira 링크 부착.
  - 영향: `run-jira-claude.sh`, 설정 추가

- [ ] **11. 처리 이력(History)**
  - 내용: 처리한 카드/시각/결과/PR URL 기록.
  - AC: JSON 이력 파일 + 대시보드에 이력 표.
  - 영향: `dashboard/server.js`, `dashboard/public/index.html`

- [ ] **12. 트리거 정밀도**
  - 내용: `text ~ "claude-work"`의 토큰화 오탐 가능성 제거.
  - AC: 텍스트 대신 전용 라벨(예: `claude-work`)을 트리거로 사용하는 옵션 제공.
  - 영향: `detect-cards.sh`, 문서

---

*완료된 항목은 위 "완료 정의"에 따라 체크 표시 + 문서 동기화 후 마감합니다.*
