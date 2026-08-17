# 훅

> [English version](../guides/hooks.md)

훅은 특정 트리거에서 액션을 발동시키는 이벤트 기반 설정 항목입니다. 바탕화면 이벤트에 대한 반응을 자동화할 수 있습니다 — 예를 들어 AI가 앱을 컴파일할 때 진행 상황 토스트를 보여주는 식입니다.

## 저장

훅은 `config/hooks.json`에 저장되며, `yaar://config/hooks`(개별 훅은 `yaar://config/hooks/{id}`)로 접근할 수 있습니다. 이 파일은 git-ignored이며, 수동으로 또는 verb 도구(`yaar://config/hooks`에 대한 `invoke`, `read`, `delete`)를 통해 관리됩니다. [URI 기반 리소스 주소 지정](../architecture/verbalized-with-uri.md)을 참조하세요.

## 이벤트 타입

| 이벤트 | 설명 | 필터 지원 |
|-------|------|----------|
| `launch` | 새 세션이 시작될 때 발동 | 없음 |
| `tool_use` | AI가 도구를 호출할 때 발동 | `verb`, `uri`, `action`, `toolName`, `appId` 필터 |
| `schedule` | 시계에 따라 발동 — [예약 훅](#예약-훅) 참조 | 없음 (`schedule` 필드를 대신 사용) |
| `link_open` | 링크를 클릭했을 때 질의됨 — [링크 처리](#링크-처리) 참조 | `url` 필터 (**필수**) |

## 액션 타입

두 종류이며, 이 차이가 어떤 이벤트에 붙일 수 있는지를 결정합니다:

- **반응**(`interaction`, `os_action`)은 발사 후 망각입니다. 무슨 일이 일어났고, 훅은 메시지나
  OS Action을 세션으로 밀어넣을 뿐 아무도 결과를 기다리지 않습니다.
- **해석기**(`open_in_app`)는 *대답*입니다. 바탕화면이 결정을 보류한 채 훅을 읽어 답을 정합니다.
  해석기는 스스로 발동하지 않으므로 `tool_use`에 붙인 해석기 — 또는 `link_open`에 붙인 반응 —
  은 아무 일도 하지 않습니다.

| 액션 | 설명 | 지원 이벤트 |
|--------|------|------------------|
| `interaction` | 세션에 사용자 메시지를 주입(페이로드는 문자열) | `launch`, `schedule` |
| `os_action` | OS Actions를 프론트엔드로 직접 발행(페이로드는 액션 객체 또는 배열) | `launch`, `tool_use`, `schedule` |
| `open_in_app` | "이 링크는 앱 X의 것"이라고 대답(페이로드는 `{ appId, command? }`) | `link_open` |

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
- 특정 앱의 에이전트만 매칭: `{ "appId": "github" }` — 모니터/세션 에이전트의 호출에는 `appId`가
  없으므로, 앱을 지정한 필터는 "앱 없음"을 "아무 앱이나"로 취급하지 않고 건너뜁니다
- 전부 매칭(필터 없음): `filter` 필드 자체를 생략

## 링크 처리

앱 안에서 클릭한 링크는 그 앱 자신의 프레임을 이동시키지 않습니다 — 바탕화면이 대신 자리를
정해서, iframe 창이나 (github.com처럼 프레이밍을 거부하는 사이트라면) 브라우저 앱에 띄웁니다.
`link_open` 훅은 *내* 데스크톱에서 특정 사이트의 링크가 어디로 갈지를 지정합니다:

```json
{
  "event": "link_open",
  "filter": { "url": "https://github.com/*" },
  "action": { "type": "open_in_app", "payload": { "appId": "github" } },
  "label": "GitHub 링크는 GitHub 앱에서 열기"
}
```

이 규칙이 있으면 모니터 어디에서 클릭하든 github.com 링크는 GitHub 앱으로 전달되고, 앱이 해당
저장소·이슈·파일로 이동합니다.

이것을 앱이 스스로 선언하는 방식이 아니라 훅으로 둔 데에는 이유가 있습니다. 앱이 자기
`app.json`에서 사이트를 주장하면 그 앱이 설치된 **모든 데스크톱에서** 아무도 동의한 적 없이
그 사이트를 가져가게 됩니다. 규칙은 사용자의 것이고, 사용자의 설정 파일에 있으며, 지우면 기본
동작으로 돌아갑니다.

| 필드 | 의미 |
|------|------|
| `filter.url` | **필수.** 정규화된 URL에 매칭되는 접두사/글롭: `https://github.com/*`. `url`이 없는 훅은 사이트를 지정하지 않은 것이므로 모든 링크를 가져가는 대신 무시됩니다. |
| `payload.appId` | 링크를 전달받을 앱 |
| `payload.command` | 링크를 받는 앱 커맨드. 기본값은 `openUrl` |
| `payload.launch` | 닫혀 있는 앱을 링크를 위해 열어도 되는지. 기본값은 **true**. 이미 떠 있을 때만 라우팅할 만한 무거운 앱이라면 `false`로 둡니다. |

이후 동작은 네 가지 규칙을 따르며, 모두 클릭이 아무 데도 가지 못하는 상황을 막기 위한 것입니다:

- **닫혀 있는 앱은 링크를 위해 열립니다**(`"launch": false`가 아니라면). 그리고 앱이 거절하면
  **다시 닫힙니다**. 바탕화면은 앱의 `yaar:app-ready` 핸드셰이크를 기다렸다가 물어보고,
  `{ handled: false }`면 방금 연 창을 되돌립니다 — 덕분에 규칙은 앱이 화면에 떠 있든 아니든
  동작하면서도, 보여주지 못한 링크 때문에 창이 남지 않습니다.
- **판단은 앱의 대답이 합니다.** 커맨드는 `{ url }`을 받고 `{ handled: true }`를 반환해야 합니다.
  그 외 — 보여줄 화면이 없어서 `{ handled: false }`, 오류, 무응답, 그런 커맨드 없음 — 는 모두
  링크를 원래의 배치 경로로 넘깁니다.
- **링크는 그것이 온 창으로 되돌려지지 않습니다.** 그 앱은 이미 자신의 `links.onOpen` 훅에서 이
  URL을 보고 넘긴 것이고, 앱 안의 "실제 페이지 열기 ↗" 링크가 바로 그런 경우입니다.
- **먼저 매칭된 훅이 이깁니다.** 좁은 규칙을 넓은 규칙 위에 두는 것이 예외를 파는 방법입니다.

앱 쪽 작업 — `openUrl` 커맨드와 앱 내 라우팅 — 은
[앱 개발](../../apps/CLAUDE.md#links-into-an-app)을 참조하세요.

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
