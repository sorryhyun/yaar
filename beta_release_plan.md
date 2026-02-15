# Beta Release Plan

Based on codebase audit conducted 2026-02-14. Scoped to the four objectives from README.md:

1. App Protocol 확장/안정화/테스트
2. Browser MCP 안정화 및 브라우저 앱 테스트
3. 다중 모니터 기능 안정화 및 테스트
4. 계층적 컨텍스트/에이전트 시스템 안정화 및 테스트

---

## What We're NOT Doing (Cut List)

`suggestions.md`와 `system_app_plan.md`의 대부분은 베타에 불필요:

- **Auth/multi-tenancy** — 베타는 로컬 전용. Remote mode는 이미 토큰 인증 구현됨 (`docs/remote_mode.md`)
- **Settings/Task Manager/Memory/Connector Hub 시스템 앱** — 유저가 파일시스템을 직접 볼 수 있음 (`config/permissions.json`, `config/memory.md`, `config/credentials/` 등). 앱으로 포장할 필요 없음
- **Connector framework, Workflow engine** — 베타 이후 기능
- **Rate limiting, quotas, cost controls** — 로컬 전용이므로 불필요
- **Marketplace supply chain hardening** — 현재 마켓은 본인 앱만 존재, 서명/검증 불필요
- **Headless browser worker** — Browser MCP로 이미 구현됨
- **Knowledge base / RAG** — 베타 이후
- **Component DSL 확장** (checkbox, radio, tabs, chart 등) — 현재 DSL로 충분, 컴파일 앱으로 대체 가능
- **OpenTelemetry, audit logs** — 베타 이후
- **SSRF hardening, CSP hardening** — 로컬 전용이므로 우선순위 낮음

---

## 1. App Protocol 안정화

### 현재 상태
아키텍처는 완성. Shared types → Frontend postMessage relay → Server MCP tools → Iframe SDK 전체 파이프라인 작동. Storage 앱이 프로덕션 수준으로 구현됨. **테스트 0개.**

### 테스트 필요

- [ ] Frontend: postMessage 왕복 테스트 (request → response 매칭)
- [ ] Frontend: 타임아웃 처리 테스트
- [ ] Frontend: 잘못된 source에서 온 응답 거부 테스트
- [ ] Server: app_query, app_command 도구 입력 검증 테스트
- [ ] Server: 타임아웃 동작 테스트
- [ ] Integration: iframe 등록 → manifest 쿼리 → command 실행 흐름

---

## 2. Browser MCP 안정화

### 현재 상태
8개 MCP 도구 (open, click, type, press, scroll, screenshot, extract, close) 완전 구현. CDP 기반. SSE 라이브 스크린샷 스트리밍. 크로스 플랫폼 Chrome/Edge 감지. 세션 풀링 (max 3, 5분 idle timeout). **테스트 0개.**

### 버그/이슈

#### P2

**2.5 `.orig` 파일 정리**
- `packages/server/src/mcp/browser/index.ts.orig` — merge 잔여물, 삭제 필요

### 테스트 필요

- [ ] 세션 라이프사이클 (생성 → idle timeout → 정리)
- [ ] 네비게이션 성공/실패
- [ ] 엘리먼트 클릭 및 텍스트 입력
- [ ] Chrome 실행 실패 처리 (Chrome 미설치 시 graceful degradation)

---

## 3. 다중 모니터 안정화

### 현재 상태
Session → Monitor (최대 4개) → Window 구조. 모니터별 main agent + 순차 큐. 윈도우 에이전트 병렬 처리. `MonitorBudgetPolicy` 구현됨.

### 테스트 필요

- [ ] 다중 모니터 동시 태스크 처리
- [ ] 모니터 생성/삭제 라이프사이클 (에이전트 정리 포함)
- [ ] 동일 ID 윈도우의 크로스 모니터 충돌 시나리오
- [ ] MonitorBudgetPolicy 레이트 제한 적용 검증

---

## 4. 컨텍스트/에이전트 시스템 안정화

### 현재 상태
ContextTape 기반 계층적 메시지 관리. 4종 에이전트 (Main, Ephemeral, Window, Task). MainQueuePolicy와 WindowQueuePolicy로 동시성 관리. 부분적 테스트 존재 (context-pool-policies.test.ts 등).

### 버그/이슈

#### P2

**4.8 타임라인 drain 순서 문제**
- 위치: `context-assembly-policy.ts` 라인 34-35
- 문제: `timeline.format()` 후에 `timeline.drain()` 호출. format이 실패하면 엔트리가 다음 턴에 중복
- 수정: drain 먼저, format 후

**4.9 WindowConnectionPolicy 루트 승격 비결정적**
- 위치: `window-connection-policy.ts` 라인 100-104
- 문제: 루트 윈도우 닫힐 때 `Set.values().next()`로 다음 루트 선택 — 순서 보장 없음
- 수정: 정렬 후 선택

### 테스트 필요

- [ ] ContextTape 크기 제한 동작
- [ ] 에이전트 cleanup 실패 시 limiter 상태
- [ ] 다중 모니터 동시 태스크 (agent limiter + budget policy)
- [ ] 리셋 중 inflight 태스크 처리
- [ ] 윈도우 그룹 루트 승격 시나리오

---

## 5. 기반 작업

### 5.1 테스트 인프라

현재 17개 테스트 파일. CI/CD 설정 완료 (`.github/workflows/ci.yml`).

- [x] GitHub Actions 설정: typecheck + test on PR
- [ ] 위 섹션 1-4의 테스트 항목 구현
- [ ] Provider 통합 테스트 (mock provider로)

### 5.2 기존 파일 정리

- [ ] `packages/server/src/mcp/browser/index.ts.orig` 삭제
- [ ] `suggestions.md` — 베타 후 로드맵으로 이동 또는 삭제
- [ ] `system_app_plan.md` — 베타 후 로드맵으로 이동 또는 삭제

---

## 우선순위 요약

| ID | 항목 | 우선순위 | 난이도 |
|----|------|----------|--------|
| 4.8 | 타임라인 drain 순서 | P2 | 낮음 |
| 4.9 | 루트 승격 비결정적 | P2 | 낮음 |
| 2.5 | .orig 파일 정리 | P2 | 낮음 |
