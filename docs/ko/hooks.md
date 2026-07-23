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

## 액션 타입

| 액션 | 설명 | 지원 이벤트 |
|--------|------|------------------|
| `interaction` | 세션에 사용자 메시지를 주입(페이로드는 문자열) | `launch`만 |
| `os_action` | OS Actions를 프론트엔드로 직접 발행(페이로드는 액션 객체 또는 배열) | `launch`, `tool_use` |

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

## 예시: 앱 개발 진행 상황 추적

`docs/guides/example_hooks.json`의 예시 설정은 앱 개발 과정을 추적하는 토스트를 보여줍니다:

| 단계 | 필터 | 상태 |
|-------|--------|------|
| Clone | `verb: invoke, uri: yaar://apps/*, action: clone` | "Cloning..." |
| Write | `verb: invoke, uri: yaar://apps/*, action: [write, edit]` | "Writing code..." |
| Compile | `verb: invoke, uri: yaar://apps/*, action: compile` | "Compiling..." |
| Deploy | `verb: invoke, uri: yaar://apps/*, action: deploy` | "Deployed!" |

### 예시 활성화하기

예시 설정을 활성 훅 파일로 복사합니다:

```bash
cp docs/guides/example_hooks.json config/hooks.json
```

그 다음 `make dev`로 서버를 시작하세요. AI가 앱 개발 도구를 사용하면 토스트가 자동으로 나타납니다.

## MCP 도구로 훅 관리하기

AI는 verb 도구를 통해 훅을 관리할 수 있습니다:

- **`invoke('yaar://config/hooks', { event, label, action, filter? })`** — 새 훅 등록 (권한 대화상자 표시)
- **`read('yaar://config/hooks/')`** 또는 **`list('yaar://config/hooks/')`** — 등록된 훅 읽기
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
