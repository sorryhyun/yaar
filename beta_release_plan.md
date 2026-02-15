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

### 버그/이슈

#### P1 (Should Fix)

**1.3 cross-origin iframe 무시 로깅**
- 위치: `packages/frontend/src/components/windows/renderers/IframeRenderer.tsx` 라인 149-151
- 문제: cross-origin iframe에 SDK 주입 실패 시 완전히 무시. 유저가 App Protocol이 왜 안 되는지 알 수 없음
- 수정: console.warn 또는 window 상태에 플래그 추가

**1.4 MCP 도구의 에러가 모두 `ok()` 반환**
- 위치: `packages/server/src/mcp/window/app-protocol.ts`
- 문제: 윈도우 미존재, 타임아웃, 응답 종류 불일치 모두 HTTP 200 OK로 반환. AI 에이전트가 에러를 구분할 수 없음
- 수정: 에러 메시지를 구조화 (예: `"ERROR: Window not found"` 접두사)

**1.5 orphaned pending request 누적**
- 위치: `packages/server/src/mcp/action-emitter.ts`
- 문제: 프론트엔드가 응답을 보내지 않는 경우 pending request map이 계속 커짐
- 수정: 타임아웃 후 map에서 제거 (현재 Promise는 reject되지만 map 엔트리는 남음)

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

#### P1

**2.2 `findByText()` 엘리먼트 매칭 부정확**
- 위치: `packages/server/src/lib/browser/session.ts` 라인 159-171
- 문제: 텍스트를 포함하는 부모 엘리먼트 중 아무거나 매칭. 동일 텍스트의 여러 부모가 있으면 잘못된 엘리먼트 클릭
- 수정: 가장 깊은(가장 구체적인) 엘리먼트 우선 매칭

**2.3 app.json 설명 부정확**
- 위치: `apps/browser/app.json`
- 문제: "Playwright sessions"라고 기재되어 있으나 실제로는 Chrome DevTools Protocol 사용
- 수정: "Chrome DevTools Protocol" 또는 "headless Chrome" 으로 변경

**2.4 연결 끊김 시각적 피드백 없음**
- 위치: `apps/browser/src/main.ts`
- 문제: SSE 연결이 끊겨도 유저에게 표시 없음
- 수정: 연결 상태 인디케이터 추가 (URL 바 옆)

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
Session → Monitor (최대 4개) → Window 구조. 모니터별 main agent + 순차 큐. 윈도우 에이전트 병렬 처리. `MonitorBudgetPolicy` 구현됨. **실제 사용에서 발견되는 심각한 이슈 다수.**

### 버그/이슈

#### P1

**3.4 모니터 구독 타이밍 문제**
- 위치: `useAgentConnection.ts` 라인 164
- 문제: `SUBSCRIBE_MONITOR` 이벤트가 WebSocket 연결 후에 전송됨 (핸드셰이크가 아닌 별도 메시지). 연결과 구독 사이에 발생하는 이벤트 누락 가능
- 현재 완화: 미구독 연결은 모든 이벤트 수신 (backward compat), 하지만 이는 모니터 스코핑 무력화
- 수정: 초기 연결 메시지에 monitorId 포함, 또는 핸드셰이크 완료 전 이벤트 버퍼링

**3.5 풀 리셋 시 다중 모니터 미처리**
- 위치: `context-pool.ts` 라인 802-883
- 문제: `reset()`이 모든 큐를 지우고 에이전트를 정리하지만, `monitor-0`만 재생성. `monitor-1`, `monitor-2`의 에이전트는 orphan됨
- 리셋 후 해당 모니터에 메시지 전송 시 hang
- 수정: 리셋 전 활성 모니터 목록 저장, 리셋 후 모두 재생성

**3.6 액티브 모니터 변경 중 액션 라우팅 경합**
- 위치: `windowsSlice.ts` 라인 22, 29
- 문제: 윈도우 액션이 `state.activeMonitorId`를 기본값으로 사용. 빠른 모니터 전환 중 잘못된 모니터에 윈도우 생성 가능
- 수정: 모든 액션에 명시적 monitorId 포함 보장

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

#### P1

**4.4 버짓 대기자 무한 대기 (잠재적 교착)**
- 위치: `monitor-budget-policy.ts` 라인 62-64
- 문제: `acquireTaskSlot()`이 백그라운드 모니터에서 무한 대기. primary 모니터가 슬롯을 해제하지 않으면 영원히 블록
- 수정: 타임아웃 추가 (예: 30초)

**4.5 윈도우 초기 컨텍스트 하드코딩**
- 위치: `context-assembly-policy.ts` 라인 68
- 문제: `buildWindowInitialContext(tape, maxTurns = 3)` — 3턴 (6메시지)으로 고정. 긴 대화에서 윈도우 에이전트가 충분한 컨텍스트를 받지 못함
- 수정: 설정 가능하게 하거나, 토큰 수 기반 동적 조정

**4.6 리로드 캐시 유사도 임계값 없음**
- 위치: `reload-cache-policy.ts` 라인 14-15
- 문제: 유사도와 관계없이 상위 3개 매치를 반환. 전혀 다른 태스크가 매칭될 수 있음
- 수정: 최소 유사도 임계값 추가 (예: 0.7)

**4.7 Codex AppServer 헬스체크 없음**
- 위치: `warm-pool.ts` 라인 155-173
- 문제: AppServer가 죽어도 감지 메커니즘 없음. 다음 provider 생성 시에만 확인
- 수정: 주기적 헬스체크 또는 프로세스 exit 감지

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

현재 17개 테스트 파일, 커버리지 매우 낮음. CI/CD 없음.

- [ ] GitHub Actions 설정: typecheck + lint + test on PR
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
| 3.4 | 모니터 구독 타이밍 | P1 | 중간 |
| 3.5 | 리셋 시 다중 모니터 미처리 | P1 | 중간 |
| 4.4 | 버짓 대기자 무한 대기 | P1 | 낮음 |
| 4.5 | 윈도우 초기 컨텍스트 하드코딩 | P1 | 낮음 |
| 4.6 | 리로드 캐시 임계값 없음 | P1 | 낮음 |
| 4.7 | Codex AppServer 헬스체크 | P1 | 중간 |
| 1.3 | Cross-origin iframe 무시 로깅 | P1 | 낮음 |
| 1.4 | MCP 도구 에러 구조화 | P1 | 낮음 |
| 1.5 | Orphaned pending request | P1 | 낮음 |
| 2.2 | findByText 부정확 | P1 | 중간 |
| 2.3 | Browser app.json 설명 | P1 | 낮음 |
| 2.4 | 연결 끊김 피드백 | P1 | 낮음 |
| 3.6 | 액션 라우팅 경합 | P1 | 중간 |
| 4.8 | 타임라인 drain 순서 | P2 | 낮음 |
| 4.9 | 루트 승격 비결정적 | P2 | 낮음 |
| 2.5 | .orig 파일 정리 | P2 | 낮음 |
| 5.1 | CI/CD 설정 | P1 | 중간 |
