# 훅

> [English version](../guides/hooks.md)

훅은 특정 트리거에서 액션을 발동시키는 이벤트 기반 설정 항목입니다. 바탕화면 이벤트에 대한 반응을 자동화할 수 있습니다 — 예를 들어 AI가 앱을 컴파일할 때 진행 상황 토스트를 보여주는 식입니다.

## 저장

훅은 `config/hooks.json`에 저장되며, `yaar://config/hooks`(개별 훅은 `yaar://config/hooks/{id}`)로 접근할 수 있습니다. 이 파일은 git-ignored이며, 수동으로 또는 verb 도구(`yaar://config/hooks`에 대한 `invoke`, `read`, `delete`)를 통해 관리됩니다. [URI 기반 리소스 주소 지정](../architecture/verbalized-with-uri.md)을 참조하세요.

## 이벤트 타입

| 이벤트 | 설명 | 필터 지원 |
|-------|------|----------|
| `launch` | 새 세션이 시작될 때 발동 | 없음 |
| `tool_use` | AI가 도구를 호출할 때 발동 | `verb`, `uri`, `action`, `toolName` 필터 |
| `schedule` | 시계에 따라 발동 — [예약 훅](#예약-훅) 참조 | 없음 (`schedule` 필드를 대신 사용) |

## 액션 타입

| 액션 | 설명 | 지원 이벤트 |
|--------|------|------------------|
| `interaction` | 세션에 사용자 메시지를 주입(페이로드는 문자열) | `launch`, `schedule` |
| `os_action` | OS Actions를 프론트엔드로 직접 발행(페이로드는 액션 객체 또는 배열) | `launch`, `tool_use`, `schedule` |

## 훅 구조

```json
{
  "id": "hook-1",
  "event": "tool_use",
  "filter": {
    "verb": "invoke",
    "uri": "yaar://apps/*",
    "action": "compile"
  },
  "action": {
    "type": "os_action",
    "payload": { "type": "toast.show", "message": "Compiling..." }
  },
  "label": "Toast on compile",
  "enabled": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### 필터 문법 (tool_use 전용)

필터는 verb 도구 컨텍스트에 대해 매칭됩니다. 모든 필터 필드는 선택 사항입니다 — 필드를 생략하면 어떤 값이든 매칭됩니다. 지정된 필드는 모두 매칭되어야 합니다(AND 로직).

| 필드 | 타입 | 설명 |
|-------|------|------|
| `verb` | `string \| string[]` | 사용된 동사: `invoke`, `read`, `list`, `delete` |
| `uri` | `string \| string[]` | URI 패턴. 끝에 `/*` 와일드카드 지원 (예: `yaar://storage/*`) |
| `action` | `string \| string[]` | invoke 호출의 `payload.action` 값(예: `compile`, `deploy`) |
| `toolName` | `string \| string[]` | 레거시: verb가 아닌 도구 이름에 매칭 (예: `WebSearch`) |

**예시:**

- 모든 storage invoke 매칭: `{ "verb": "invoke", "uri": "yaar://storage/*" }`
- 모든 storage read 매칭: `{ "verb": "read", "uri": "yaar://storage/*" }`
- 모든 apps invoke 매칭: `{ "verb": "invoke", "uri": "yaar://apps/*" }`
- verb가 아닌 도구 매칭: `{ "toolName": "WebSearch" }`
- 전부 매칭(필터 없음): `filter` 필드 자체를 생략

## 예약 훅

`schedule` 훅은 이벤트가 아니라 시계에 따라 발동합니다. YAAR의 cron에 해당합니다 — crontab에 넣을 만한 것은 `interaction`(에이전트 턴) 또는 `os_action`(토스트, 윈도우)을 액션으로 갖는 훅으로 작성하면 됩니다.

```json
{
  "event": "schedule",
  "schedule": { "every": "30m" },
  "action": { "type": "interaction", "payload": "빌드를 확인하고, 깨졌을 때만 토스트로 알려줘." },
  "label": "Build watch"
}
```

### 스케줄 문법

`every` 또는 `at` 중 **정확히 하나**만 지정합니다. cron 표현식은 없습니다 — 이 두 가지가 데스크톱에 실제로 필요한 범위를 덮고, 설정 파일을 나중에 물려받는 사람도 그대로 읽을 수 있습니다.

| 필드 | 형식 | 의미 |
|-------|------|------|
| `every` | `"90s"`, `"15m"`, `"2h"`, `"1d"` | 마지막 실행으로부터의 고정 간격. **최소 `1m`.** |
| `at` | `"09:00"` | 매일 해당 시각(24시간제), **서버**의 로컬 타임존 기준 |

`monitorId`(선택)로 훅이 작동할 모니터를 지정할 수 있으며, 기본값은 첫 번째 모니터입니다.

`every`의 하한은 해상도 제한이 아니라 비용 제한입니다: `interaction` 훅은 온전한 에이전트 턴이므로 `"every": "1s"`는 매초 과금됩니다. 검증에 실패한 스케줄은 등록 시점에 거부되고, `hooks.json`을 직접 편집해 넣은 잘못된 스케줄은 건너뛰며 그 사실이 로그에 남습니다.

### 아무도 보고 있지 않을 때

훅은 세션 *안으로* 발동하지만, 시계는 세션이 있는지 신경 쓰지 않습니다. 여기서 세 가지 규칙이 나오며, 이 기능에 의존하기 전에 이해해 둘 가치가 있는 부분입니다:

- **발동할 곳이 없는 occurrence는 쌓이지 않고 버려집니다.** 훅이 발동할 시점에 연결된 세션이 없으면, 해당 occurrence는 실행된 것으로 기록하고 건너뜁니다. 그러지 않으면 오후 4시에 노트북을 열었을 때 그동안 잠들어 있던 "good morning" 턴이 한꺼번에 쏟아집니다.
- **놓친 실행은 딱 한 번만 따라잡습니다.** 10시 30분까지 잠들어 있던 기기의 `09:00` 훅은 10시 30분에 한 번 발동하며, 놓친 나흘치가 네 번 발동하지는 않습니다.
- **타이머는 세션을 새로 띄우지 않고, 진행 중인 턴을 끊지도 않습니다.** 예약된 `interaction`은 해당 모니터가 턴 진행 중이거나 메시지가 대기 중이면 건너뜁니다. 그래서 1분 훅이 느린 턴 하나 뒤에 밀려 쌓이는 일이 없습니다. `os_action`(토스트)은 뒤에 밀릴 것이 없으므로 그대로 전달됩니다.

실행 기록은 훅의 `lastRunAt`에 남으며, 값은 틱이 알아챈 순간이 아니라 예정된 슬롯입니다. 그래서 `15m` 훅이 매번 틱 간격만큼 밀리지 않고 15분 경계를 유지하고, 재시작이 스케줄을 다시 재생하지 않습니다.

## 예시: 앱 개발 진행 상황 추적

`docs/guides/example_hooks.json`의 예시 설정은 앱 개발 과정을 추적하는 토스트와 `launch` 훅 하나를 보여줍니다:

| 훅 | 이벤트 | 필터 | 효과 |
|-------|--------|--------|------|
| `hook-1` | `tool_use` | `verb: invoke, uri: yaar://apps/*, action: clone` | "Cloning..." 토스트 |
| `hook-2` | `tool_use` | `verb: invoke, uri: yaar://apps/*, action: [write, edit]` | "Writing code..." 토스트 |
| `hook-5` | `tool_use` | `verb: invoke, uri: yaar://windows/*, action: app_command` | "Sending command to app..." 토스트 |
| `hook-8` | `launch` | — | 부팅 시 Dock 창을 엽니다 |

### 예시 활성화하기

예시 설정을 활성 훅 파일로 복사합니다:

```bash
cp docs/guides/example_hooks.json config/hooks.json
```

그 다음 `make dev`로 서버를 시작하세요. AI가 앱 개발 도구를 사용하면 토스트가 자동으로 나타납니다.

## MCP 도구로 훅 관리하기

AI는 verb 도구를 통해 훅을 관리할 수 있습니다:

- **`invoke('yaar://config/hooks', { event, label, action, filter?, schedule?, monitorId? })`** — 새 훅 등록 (권한 대화상자 표시, `schedule` 훅이면 주기도 함께 표시)
- **`read('yaar://config/hooks/')`** — 등록된 훅 읽기 (이 리소스는 `describe`/`read`/`invoke`만 등록하며, `list`는 컬렉션이 아니라는 이유로 거부됩니다)
- **`delete('yaar://config/hooks/{id}')`** — ID로 훅 삭제 (확인 대화상자 표시)

### 예시: 훅 추가하기

```json
{
  "event": "tool_use",
  "filter": {
    "verb": "invoke",
    "uri": "yaar://apps/*",
    "action": "compile"
  },
  "action": {
    "type": "os_action",
    "payload": {
      "type": "toast.show",
      "id": "dev-compile",
      "message": "Compiling app...",
      "variant": "info"
    }
  },
  "label": "Show compile toast"
}
```

## 동작 방식

1. AI가 verb 도구를 호출하면(예: `invoke('yaar://apps/my-app', { action: 'set_badge', count: 3 })`), `StreamToEventMapper`가 도구 입력에서 verb, URI, action을 추출합니다
2. `getToolUseHooks({ toolName, verb, uri, action })`를 통해 매칭되는 `tool_use` 훅이 있는지 확인합니다
3. `os_action` 액션을 가진 매칭된 훅마다, `actionEmitter`를 통해 OS Action(들)이 발행됩니다
4. 프론트엔드가 이 액션들을 수신하고 처리합니다 (토스트 표시, 윈도우 생성 등)

훅 액션은 액션 이미터로부터 현재 에이전트 컨텍스트(agentId, monitorId)를 물려받으므로, 활성 세션으로 올바르게 라우팅됩니다.

`launch`와 `schedule` 훅은 훅 전체가 실행되며, 둘 다 `LiveSession.runHookAction()`을 거칩니다 — 훅의 의미가 무엇이 훅을 건드렸는지에 따라 달라지지 않도록 하기 위해서입니다. `schedule` 뒤의 시계는 부팅 시 시작되는 `features/config/hook-scheduler.ts`의 프로세스 전역 인터벌 하나이고, 그것이 읽는 시간 계산은 `features/config/hook-schedule.ts`에 있습니다.
