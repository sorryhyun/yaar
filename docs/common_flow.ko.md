# 에이전트 아키텍처: 풀, 컨텍스트, 메시지 흐름

이 문서는 YAAR가 통합 풀링, 계층적 컨텍스트, 정책 기반 오케스트레이션을 통해 동시 다발적 AI 에이전트를 관리하는 방법을 설명합니다.

## 개요

```
┌──────────────────────────────────────────────────────────────────────┐
│                   SessionHub (싱글턴 레지스트리)                       │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                LiveSession (대화별 하나)                        │  │
│  │         연결 끊김에도 유지, 멀티탭 지원                           │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                      ContextPool                         │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │  │
│  │  │  │ AgentPool  │  │ ContextTape │  │ Interaction      │  │  │  │
│  │  │  │            │  │ (출처별     │  │ Timeline         │  │  │  │
│  │  │  │ Main(1/모니)│  │  메시지     │  │ (유저+AI 이벤트, │  │  │  │
│  │  │  │ Ephemeral* │  │  히스토리)  │  │ 메인 에이전트 턴  │  │  │  │
│  │  │  │ Window*    │  │             │  │ 에 소비)         │  │  │  │
│  │  │  │ Task*      │  │             │  │                  │  │  │  │
│  │  │  └────────────┘  └─────────────┘  └──────────────────┘  │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌──────────────────────────────────────────────────┐    │  │  │
│  │  │  │ Policies                                         │    │  │  │
│  │  │  │ MainQueue(모니터별) · WindowQueue ·               │    │  │  │
│  │  │  │ ContextAssembly · ReloadCache · WindowConnection │    │  │  │
│  │  │  │ MonitorBudget                                    │    │  │  │
│  │  │  └──────────────────────────────────────────────────┘    │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## 에이전트 유형

### 1. 메인 에이전트

모니터별 메인 대화 흐름을 담당하는 영속 에이전트입니다. 메시지 간 프로바이더 세션 연속성을 유지합니다.

- **Role**: `main-{monitorId}-{messageId}` (메시지별로 설정)
- **생성**: 모니터당 하나. 기본 모니터(`monitor-0`)는 풀 초기화 시 워밍된 프로바이더로 생성되고, 추가 모니터는 필요 시 자동 생성 (최대 4개)
- **세션**: 메시지 간에 동일한 프로바이더 세션을 재개하여 전체 대화 이력을 유지
- **정규 ID**: `main-{monitorId}`

### 2. 임시(Ephemeral) 에이전트

메인 에이전트가 처리 중일 때 새로운 메인 태스크가 도착하면 생성되는 임시 에이전트입니다. 대화 이력 없이 새 프로바이더를 할당받으며, 태스크 완료 후 즉시 폐기됩니다.

- **Role**: `ephemeral-{monitorId}-{messageId}`
- **생성**: 메인 에이전트가 처리 중이고 글로벌 `AgentLimiter`가 허용할 때 온디맨드 생성
- **컨텍스트**: 대화 이력 없음 — 열린 윈도우 + 리로드 옵션 + 태스크 내용만 수신
- **생명주기**: 생성 → 태스크 처리 → InteractionTimeline에 기록 → 폐기

### 3. 윈도우 에이전트

윈도우별 인터랙션(버튼 클릭, 컨텍스트 메뉴 메시지)을 처리하는 영속 에이전트입니다. 각 윈도우(또는 윈도우 그룹)는 자체 프로바이더 세션을 가진 고유 에이전트를 갖습니다.

- **Role**: `window-{windowId}` 또는 `window-{windowId}/{actionId}` (병렬 버튼 액션용)
- **생성**: 해당 윈도우에 대한 첫 `COMPONENT_ACTION` 또는 `WINDOW_MESSAGE` 발생 시
- **컨텍스트**: 첫 인터랙션 시 ContextTape에서 최근 메인 대화를 주입받고, 이후 인터랙션은 프로바이더 세션 연속성 사용
- **그루핑**: 윈도우 에이전트가 생성한 자식 윈도우는 부모 그룹에 합류하여 하나의 에이전트를 공유
- **정규 ID**: `window-{agentKey}` (agentKey = groupId 또는 windowId)

### 4. 태스크 에이전트

`dispatch_task` 도구로 생성되는 임시 에이전트입니다. 메인 에이전트의 프로바이더 세션을 포크하여 전체 대화 컨텍스트를 상속받고, 프로필별 도구 서브셋과 시스템 프롬프트로 실행됩니다.

- **Role**: `task-{messageId}-{timestamp}`
- **생성**: `dispatch_task` 도구 호출 시 (글로벌 `AgentLimiter`에 의해 제한)
- **컨텍스트**: 메인 에이전트의 세션을 포크 — 전체 대화 이력 상속
- **생명주기**: 생성 → 목표 처리 → InteractionTimeline에 기록 → 폐기

## 멀티 모니터 아키텍처

모니터는 단일 세션 내의 가상 데스크톱입니다. 각각 고유한 메인 에이전트와 순차 큐를 갖습니다.

- **기본 모니터** (`monitor-0`): 항상 존재하며 제한 없음
- **백그라운드 모니터** (`monitor-1`, `monitor-2`, ...): `USER_MESSAGE`가 새 monitorId를 지정하면 자동 생성, 최대 4개
- **독립성**: 각 모니터는 자체 메인 에이전트와 메인 큐를 갖지만, 모든 모니터는 동일한 윈도우 상태, 컨텍스트 테이프, 타임라인, 리로드 캐시를 공유
- **예산 제한**: 백그라운드 모니터는 `MonitorBudgetPolicy`에 의해 속도 제한 (동시 태스크, 액션/분, 출력/분). 기본 모니터는 모든 제한을 우회

## 메시지 흐름

### 유저 메시지 → 메인 에이전트

유저 메시지가 도착하면 시스템은 우선순위대로 전략을 시도합니다:

```
USER_MESSAGE 도착 (monitorId)
│
├─ 메인 에이전트 유휴 → processMainTask()로 직접 처리
│
└─ 메인 에이전트 처리 중:
   │
   ├─ 1. Steer → 활성 턴에 주입 (Codex: turn/steer, Claude: streamInput)
   │     성공: AI가 응답 중에 새 입력을 반영, MESSAGE_ACCEPTED
   │     실패: 프로바이더가 미지원이거나 턴이 방금 종료됨
   │
   ├─ 2. Ephemeral → 새 프로바이더, 병렬 응답
   │     성공: 일회용 에이전트로부터 두 번째 응답을 받음
   │     실패: 글로벌 에이전트 한도 도달
   │
   └─ 3. Queue → MainQueuePolicy.enqueue()
         성공: MESSAGE_QUEUED, 메인 에이전트 완료 후 처리
         실패: 큐 가득 참 (모니터당 10개)
```

직접 처리 전체 흐름:

```
프론트엔드                  서버                            AI 프로바이더
   │                          │                                  │
   │  USER_MESSAGE            │                                  │
   ├─────────────────────────>│                                  │
   │                          │  예산 확인 (백그라운드만)           │
   │                          │  메인 에이전트 유휴?               │
   │                          │  ├─ 예: processMainTask()        │
   │                          │  └─ 아니오: steer / ephemeral / queue
   │                          │                                  │
   │  MESSAGE_ACCEPTED        │  프롬프트 구성:                    │
   │<─────────────────────────│  timeline + openWindows +        │
   │                          │  reloadOptions + content         │
   │                          │                                  │
   │                          │  provider.query(prompt, {        │
   │                          │    sessionId,                    │
   │                          │    systemPrompt                  │
   │                          │  })                              │
   │                          ├─────────────────────────────────>│
   │                          │                                  │
   │  AGENT_THINKING          │<─────────────────────────────────│
   │<─────────────────────────│  스트림 메시지                     │
   │                          │                                  │
   │  AGENT_RESPONSE          │<─────────────────────────────────│
   │<─────────────────────────│  (캐시를 위해 액션 기록)            │
   │                          │                                  │
   │                          │  대기 중인 메인 큐 소비             │
   │                          │                                  │
```

### 버튼 클릭 → 윈도우 에이전트

```
프론트엔드                  서버                            AI 프로바이더
   │                          │                                  │
   │  COMPONENT_ACTION        │                                  │
   │  { windowId, action,     │                                  │
   │    actionId?, formData?} │                                  │
   ├─────────────────────────>│                                  │
   │                          │                                  │
   │                          │  그룹 해석: windowId →            │
   │                          │  agentKey (groupId 또는 windowId) │
   │                          │                                  │
   │                          │  해당 agentKey의 에이전트 존재?     │
   │                          │  ├─ 예: 재사용                    │
   │                          │  └─ 아니오: 생성 (새 프로바이더)    │
   │                          │                                  │
   │  WINDOW_AGENT_STATUS     │  첫 메시지?                       │
   │  { status: 'active' }    │  ├─ 예: ContextTape에서 최근 메인  │
   │<─────────────────────────│  │  컨텍스트 주입                  │
   │                          │  └─ 아니오: 세션 연속성             │
   │                          │                                  │
   │                          │  provider.query(prompt, {        │
   │                          │    sessionId                     │
   │                          │  })                              │
   │                          ├─────────────────────────────────>│
   │                          │                                  │
   │  AGENT_RESPONSE          │  완료 후:                         │
   │<─────────────────────────│  - InteractionTimeline에 기록     │
   │                          │  - 자식 윈도우 그룹 추적            │
   │                          │  - 리로드용 액션 캐싱              │
   │                          │                                  │
```

## ContextTape: 계층적 메시지 이력

메시지는 계층적 추적을 위해 출처 태그가 지정됩니다:

```typescript
type ContextSource = 'main' | { window: string };

interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  source: ContextSource;
}
```

**사용 방법:**
- **메인 에이전트 프롬프트**: ContextTape를 주입하지 않음 (프로바이더 세션 연속성에 의존)
- **윈도우 에이전트 첫 턴**: `buildWindowInitialContext()`를 통해 최근 메인 대화 3턴을 주입
- **윈도우 닫기**: 해당 윈도우의 메시지를 테이프에서 제거
- **세션 복원**: 이전 세션 로그에서 ContextTape 복원 가능

## InteractionTimeline

유저 발생 이벤트와 AI 에이전트 액션 요약을 시간순으로 교차 기록하는 타임라인입니다. 메인 에이전트는 다음 턴에 이를 소비하여 유휴 상태 동안 발생한 모든 일을 확인합니다.

```
유저가 윈도우 닫음  → pushUser({ type: 'window.close', windowId: '...' })
윈도우 에이전트 실행 → pushAI(role, task, actions, windowId)
임시 에이전트        → pushAI(role, task, actions)
태스크 에이전트 실행 → pushAI(role, task, actions)

메인 에이전트 턴    → timeline.format() → drain()
  결과:
  <timeline>
  <ui:close>settings-win</ui:close>
  <ai agent="window-main-win">Created window "chart". Updated content.</ai>
  </timeline>
```

## 정책(Policies)

### MainQueuePolicy
모니터별 FIFO 큐 (최대 10개). 메인 에이전트가 처리 중이고 임시 에이전트를 생성할 수 없을 때 메인 태스크를 대기시킵니다. 상호 배제를 통해 큐가 순차적으로 소비됩니다.

### WindowQueuePolicy
윈도우별 큐. 같은 윈도우에 대한 태스크는 직렬화됩니다(한 번에 하나만 활성). 다른 윈도우에 대한 태스크는 병렬로 실행됩니다. 병렬 버튼 액션(`actionId`)은 큐를 우회합니다.

### ContextAssemblyPolicy
메인 에이전트와 윈도우 에이전트 모두의 프롬프트를 구성합니다:
- **메인**: `timeline + openWindows + reloadOptions + content`
- **윈도우 (첫 턴)**: `recentMainContext + openWindows + reloadOptions + content`
- **윈도우 (이후)**: `openWindows + reloadOptions + content`

### ReloadCachePolicy
액션 시퀀스의 핑거프린트 기반 캐싱. 각 태스크 후 액션이 핑거프린트(내용 해시 + 윈도우 상태 해시)와 함께 기록됩니다. 다음 유사한 태스크에서 매칭되는 캐시된 액션이 `<reload_options>`로 주입되어 AI가 즉시 재사용할 수 있습니다.

### WindowConnectionPolicy
윈도우 그룹을 추적합니다. 윈도우 에이전트가 자식 윈도우를 생성하면 자식은 부모 그룹에 합류합니다. 그룹의 모든 윈도우는 하나의 에이전트를 공유합니다. 그룹의 에이전트는 마지막 윈도우가 닫힐 때만 폐기됩니다.

### MonitorBudgetPolicy
백그라운드 모니터에 대한 모니터별 속도 제한. 세 가지 예산 차원:
1. **동시 태스크 세마포어** (기본: 2) — 백그라운드 모니터가 동시에 쿼리를 실행하는 최대 수. 기본 모니터는 우회.
2. **액션 속도 제한** (기본: 100 액션/분) — 모니터별 60초 슬라이딩 윈도우.
3. **출력 속도 제한** (기본: 1MB/분) — 모니터별 60초 슬라이딩 윈도우.

## AgentPool 생명주기

```
┌───────────────────────────────────────────────────────────────┐
│                         AgentPool                             │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ 메인 에이전트 (영속, 모니터당 하나)                       │  │
│   │ - 기본(monitor-0)은 풀 초기화 시 생성                    │  │
│   │ - 추가 모니터는 필요 시 자동 생성 (최대 4개)               │  │
│   │ - 메시지 간 프로바이더 세션 연속성 유지                    │  │
│   │ - 풀 리셋 시 재생성                                      │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ 임시(Ephemeral) 에이전트 (일시적)                        │  │
│   │ - 메인이 처리 중 + 글로벌 한도 허용 시 생성               │  │
│   │ - 새 프로바이더, 대화 컨텍스트 없음                       │  │
│   │ - 태스크 후 즉시 폐기                                    │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ 윈도우 에이전트 (그룹/윈도우별 영속)                      │  │
│   │ - 윈도우에 대한 첫 인터랙션 시 생성                       │  │
│   │ - agentKey로 키 지정 (그룹화 시 groupId, 단독 시         │  │
│   │   windowId)                                              │  │
│   │ - 그룹의 마지막 윈도우가 닫히면 폐기                      │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ 태스크 에이전트 (일시적, 포크된 컨텍스트)                  │  │
│   │ - dispatch_task 도구로 생성                               │  │
│   │ - 메인 에이전트의 프로바이더 세션을 포크                    │  │
│   │ - 프로필별 도구와 시스템 프롬프트                          │  │
│   │ - 태스크 후 즉시 폐기                                    │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   글로벌 한도: AgentLimiter (기본: 동시 에이전트 10개)          │
└───────────────────────────────────────────────────────────────┘
```

## 윈도우 에이전트 생명주기

```
┌──────────────────────────────────────────────────────────────────┐
│                     윈도우 에이전트 생명주기                        │
│                                                                   │
│   COMPONENT_ACTION / WINDOW_MESSAGE                               │
│        │                                                          │
│        ▼                                                          │
│   WindowConnectionPolicy: agentKey 해석                           │
│   (윈도우가 그룹에 속하면 groupId, 아니면 windowId)                  │
│        │                                                          │
│        ▼                                                          │
│   ┌─────────────┐                                                │
│   │ 해당 키의   │ 아니오 ──> getOrCreateWindowAgent(agentKey)     │
│   │ 에이전트    │           + acquireWarmProvider()               │
│   │ 존재?      │                                                 │
│   └──────┬──────┘                                                │
│          │ 예                                                     │
│          ▼                                                        │
│   ┌─────────────┐                                                │
│   │ 키가 처리  │ 예 ──> WindowQueuePolicy.enqueue()              │
│   │ 중? (비병렬)│       → MESSAGE_QUEUED                         │
│   └──────┬──────┘                                                │
│          │ 아니오                                                  │
│          ▼                                                        │
│   ┌─────────────────────────────────────────────┐                │
│   │ 처리:                                        │                │
│   │  첫 메시지 → ContextTape 초기 컨텍스트        │                │
│   │  이후 메시지 → 프로바이더 세션 연속성          │                │
│   │                                              │                │
│   │  완료 후:                                    │                │
│   │  - 액션 기록 → ReloadCache                   │                │
│   │  - 자식 윈도우 연결 → 그룹                    │                │
│   │  - InteractionTimeline에 기록                │                │
│   └─────────────────────────────────────────────┘                │
│                                                                   │
│   윈도우 닫힘 → WindowConnectionPolicy.handleClose()              │
│     ├─ 그룹 내 마지막 → disposeWindowAgent() + ContextTape 정리   │
│     └─ 다른 윈도우 남음 → 에이전트 유지, 해당 윈도우 컨텍스트 정리  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## 이벤트 유형

### 클라이언트 → 서버

| 이벤트 | 설명 |
|--------|------|
| `USER_MESSAGE` | 메인 입력 → ContextPool 메인 큐 (모니터별 순차) |
| `WINDOW_MESSAGE` | 컨텍스트 메뉴 "윈도우로 보내기" → 윈도우 에이전트 |
| `COMPONENT_ACTION` | 버튼 클릭 (선택적 formData, componentPath 포함) → 윈도우 에이전트 |
| `INTERRUPT` | 모든 에이전트 중단 |
| `INTERRUPT_AGENT` | role로 특정 에이전트 중단 |
| `RESET` | 모두 중단, 컨텍스트 초기화, 메인 에이전트 재생성 |
| `SET_PROVIDER` | AI 프로바이더 전환 (claude/codex) |
| `RENDERING_FEEDBACK` | 프론트엔드가 윈도우 렌더링 성공/실패 보고 |
| `DIALOG_FEEDBACK` | 승인 다이얼로그에 대한 유저 응답 |
| `TOAST_ACTION` | 리로드 토스트 닫기 (캐시 항목 실패 처리) |
| `USER_INTERACTION` | 유저 인터랙션 배치 (닫기, 포커스, 이동, 리사이즈, 그리기) |
| `APP_PROTOCOL_RESPONSE` | iframe 앱의 에이전트 쿼리/명령에 대한 응답 |
| `APP_PROTOCOL_READY` | iframe 앱이 App Protocol에 등록 완료 |

### 서버 → 클라이언트

| 이벤트 | 설명 |
|--------|------|
| `ACTIONS` | 실행할 OS Actions 배열 |
| `AGENT_THINKING` | 에이전트 사고 스트림 (agentId 포함) |
| `AGENT_RESPONSE` | 에이전트 응답 텍스트 스트림 (agentId, messageId 포함) |
| `CONNECTION_STATUS` | connected/disconnected/error (프로바이더명 포함) |
| `TOOL_PROGRESS` | 도구 실행 상태 (running/complete/error) |
| `ERROR` | 에러 메시지 (선택적 agentId 포함) |
| `WINDOW_AGENT_STATUS` | 윈도우 에이전트 생명주기: assigned/active/released |
| `MESSAGE_ACCEPTED` | 메시지가 에이전트에 배정됨 |
| `MESSAGE_QUEUED` | 메시지 대기열 추가 (에이전트 처리 중 또는 한도 도달) |
| `APPROVAL_REQUEST` | 유저 승인을 위한 권한 다이얼로그 |
| `APP_PROTOCOL_REQUEST` | 에이전트가 iframe 앱에 상태/명령 요청 |

## 공유 세션 로거

모든 에이전트는 통합 이력을 위해 단일 `SessionLogger`를 공유합니다:

```
session_logs/
└── 2026-02-08_14-38-08/
    ├── metadata.json     # 세션 메타데이터 (프로바이더, threadIds)
    └── messages.jsonl    # 모든 에이전트의 전체 메시지
```

각 로그 항목에는 필터링을 위한 `agentId`가 포함됩니다:

```json
{"type":"user","content":"Hello","agentId":"main-msg-1","source":"main"}
{"type":"assistant","content":"Hi!","agentId":"main-msg-1","source":"main"}
{"type":"user","content":"Click Save","agentId":"window-settings","source":{"window":"settings"}}
{"type":"assistant","content":"Saved","agentId":"window-settings","source":{"window":"settings"}}
```

## 주요 파일

| 파일 | 역할 |
|------|------|
| `session/live-session.ts` | LiveSession + SessionHub — 세션 생명주기, 다중 연결 |
| `session/event-sequencer.ts` | EventSequencer — 이벤트 재생을 위한 단조 증가 시퀀스 |
| `agents/context-pool.ts` | ContextPool — 통합 태스크 오케스트레이션 |
| `agents/agent-pool.ts` | AgentPool — 메인(모니터별), 임시, 윈도우, 태스크 에이전트 관리 |
| `agents/session.ts` | AgentSession — 프로바이더 + 스트림 매핑을 가진 개별 에이전트 |
| `agents/context.ts` | ContextTape — 계층적 메시지 이력 |
| `agents/interaction-timeline.ts` | InteractionTimeline — 유저 + AI 이벤트 연대기 |
| `agents/limiter.ts` | AgentLimiter — 에이전트 한도 글로벌 세마포어 |
| `agents/session-policies/` | StreamToEventMapper, ProviderLifecycleManager, ToolActionBridge |
| `agents/context-pool-policies/` | MainQueue, WindowQueue, ContextAssembly, ReloadCache, WindowConnection, MonitorBudget |
| `providers/factory.ts` | 프로바이더 자동 감지 및 생성 |
| `providers/warm-pool.ts` | 빠른 첫 응답을 위한 사전 초기화 프로바이더 |
| `websocket/broadcast-center.ts` | BroadcastCenter — 세션 내 모든 연결에 이벤트 라우팅 |
| `mcp/action-emitter.ts` | ActionEmitter — MCP 도구와 에이전트 세션 연결 |
| `mcp/window-state.ts` | WindowStateRegistry — 세션별 열린 윈도우 추적 |
| `mcp/domains.ts` | HTTP 도구 및 샌드박스 fetch용 도메인 허용 목록 |
| `mcp/guidelines/` | 동적 참조 문서 (app_dev, sandbox, components) |
| `mcp/app-dev/` | 앱 개발 도구 (write, read, diff, compile, deploy, clone) |
| `mcp/window/app-protocol.ts` | App Protocol 도구 (app_query, app_command) |

## 예시: 동시 실행

```
타임라인:
──────────────────────────────────────────────────────────────────────────>

유저가 "Hello" 입력          유저가 윈도우 A에서 Save 클릭
       │                              │
       ▼                              ▼
┌──────────────┐              ┌──────────────┐
│ 메인 에이전트 │              │ 윈도우       │
│ (monitor-0)  │              │ 에이전트     │
│              │              │ (group-A)    │
│ 전체 세션    │              │ 첫 턴:       │
│ 이력으로     │              │ ContextTape  │
│ "Hello"      │              │ 초기 컨텍스트│
│ 처리 중      │              │              │
│              │              │ Save 액션    │
│              │              │ 처리 중      │
└──────┬───────┘              └──────┬───────┘
       │                              │
       ▼                              ▼
   유저에게                    윈도우 A
   응답                       업데이트
                                    │
                                    ▼
                         InteractionTimeline 기록:
                         "window-A: 콘텐츠 업데이트"
                         (메인 에이전트가 다음 턴에 확인)
```
