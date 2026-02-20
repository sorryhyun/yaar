# 앱 개발 가이드

YAAR에서는 AI에게 말하면 앱이 만들어집니다. TypeScript 작성, 컴파일, 프리뷰, 바탕화면 배포까지 모두 AI가 MCP 도구로 처리합니다.

> [English version](#english)

## 개발 흐름

```
"테트리스 만들어줘"

    ↓  AI가 코드 작성 (write_ts)
    ↓  컴파일 (compile) → 단일 HTML 파일
    ↓  iframe 윈도우로 프리뷰
    ↓  바탕화면에 배포 (deploy)

🎮 바탕화면에 테트리스 아이콘 등장
```

사용자는 코드를 직접 작성할 필요가 없습니다. AI가 샌드박스에서 TypeScript를 작성하고, esbuild로 컴파일하고, 프리뷰한 뒤 앱으로 배포합니다.

## MCP 도구

### 앱 개발 도구

| 도구 | 설명 |
|------|------|
| `write_ts` | 샌드박스에 TypeScript 파일 작성 |
| `read_ts` | 샌드박스 파일 읽기 (경로 미지정 시 파일 목록) |
| `apply_diff_ts` | 샌드박스 파일에 검색-치환 편집 |
| `compile` | `src/main.ts` → 단일 HTML로 번들 (esbuild) |
| `compile_component` | 샌드박스에 `.yaarcomponent.json` 파일 생성 |
| `typecheck` | 샌드박스 TypeScript 타입 검사 |
| `deploy` | 컴파일된 앱을 바탕화면에 배포 |
| `clone` | 배포된 앱의 소스를 샌드박스로 복제 (편집용) |
| `write_json` | 배포된 앱에 JSON 파일 직접 쓰기 |

### 코드 실행 도구

| 도구 | 설명 |
|------|------|
| `run_js` | JavaScript를 샌드박스 VM에서 실행 |

### 레퍼런스 도구

| 도구 | 설명 |
|------|------|
| `skill` | 토픽별 참조 문서 로드 (`app_dev`, `sandbox`, `components`, `host_api`, `app_protocol`) |

### 앱 관리 도구

| 도구 | 설명 |
|------|------|
| `apps_list` | 앱 목록 조회 |
| `apps_load_skill` | 앱의 SKILL.md 로드 |
| `apps_read_config` | 설정/소스 파일 읽기 |
| `apps_write_config` | 설정 파일 쓰기 |
| `market_list` | 마켓플레이스 앱 목록 조회 |
| `market_get` | 마켓플레이스에서 앱 설치 |
| `market_delete` | 설치된 앱 삭제 |

## 개발 워크플로우 상세

### 1단계: 코드 작성 — `write_ts`

```
write_ts(path: "src/main.ts", content: "...", sandboxId?: "...")
```

- 격리된 샌드박스 디렉토리에 파일 생성
- `sandboxId` 미지정 시 자동 생성
- 여러 파일 작성 가능 (`src/main.ts`, `src/utils.ts`, ...)

### 2단계: 컴파일 — `compile`

```
compile(sandboxId: "1739xxx", title?: "My App")
```

- `src/main.ts`를 진입점으로 esbuild 번들링
- JS가 내장된 **단일 HTML 파일** 생성
- 프리뷰 URL 반환: `/api/sandbox/{sandboxId}/dist/index.html`

### 3단계: 프리뷰

AI가 iframe 윈도우를 열어 컴파일 결과를 바로 확인합니다.

### 4단계: 배포 — `deploy`

```
deploy(sandboxId: "1739xxx", appId: "my-app", name?: "My App", icon?: "🚀",
       keepSource?: true, skill?: "...", appProtocol?: true,
       fileAssociations?: [{ extensions: [".txt"], command: "openFile", paramKey: "content" }])
```

- 컴파일된 HTML을 `apps/{appId}/`로 복사
- `SKILL.md`와 `app.json` 자동 생성
- 바탕화면에 아이콘 즉시 등장
- `appProtocol`: App Protocol 지원 여부 (HTML에서 자동 감지, 수동 설정 가능)
- `fileAssociations`: 앱이 열 수 있는 파일 확장자 매핑

### 기존 앱 수정 — `clone` → 편집 → `compile` → `deploy`

```
clone(appId: "my-app") → sandboxId 반환
apply_diff_ts(sandboxId, path, old_string, new_string)  // 또는 write_ts로 전체 교체
compile(sandbox: sandboxId)
deploy(sandbox: sandboxId, appId: "my-app")  // 동일 appId로 덮어쓰기
```

## 번들 라이브러리

npm 설치 없이 `@bundled/*`로 바로 사용 가능:

| 라이브러리 | import 경로 | 용도 |
|-----------|------------|------|
| uuid | `@bundled/uuid` | ID 생성 |
| lodash | `@bundled/lodash` | 유틸리티 (debounce, cloneDeep, groupBy 등) |
| date-fns | `@bundled/date-fns` | 날짜 처리 |
| clsx | `@bundled/clsx` | CSS 클래스 조합 |
| anime.js | `@bundled/anime` | 애니메이션 |
| Konva | `@bundled/konva` | 2D 캔버스 그래픽 |
| Three.js | `@bundled/three` | 3D 그래픽 |
| cannon-es | `@bundled/cannon-es` | 3D 물리 엔진 |
| xlsx | `@bundled/xlsx` | 스프레드시트 파싱/생성 |
| Chart.js | `@bundled/chart.js` | 차트/그래프 |
| D3 | `@bundled/d3` | 데이터 시각화 |
| Matter.js | `@bundled/matter-js` | 2D 물리 엔진 |
| Tone.js | `@bundled/tone` | 오디오/음악 |
| PixiJS | `@bundled/pixi.js` | 2D WebGL 렌더링 |
| p5.js | `@bundled/p5` | 크리에이티브 코딩 |

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

## 샌드박스 실행 환경

`run_js`는 격리된 VM에서 코드를 실행합니다.

**사용 가능:** JSON, Math, Date, Promise, fetch (도메인 제한), crypto.createHash, TextEncoder/Decoder, 타입 배열

**차단됨:** process, require, import, eval, Function, fs, os, setTimeout/setInterval

- 타임아웃: 100ms ~ 30,000ms (기본 5,000ms)
- fetch 허용 도메인: `config/curl_allowed_domains.yaml`에서 관리

## 런타임 제약 사항

컴파일된 앱은 **브라우저 iframe 샌드박스**에서 실행됩니다. 다음과 같은 하드 제약이 있습니다:

- **Node.js API 없음** — `fs`, `process`, `child_process`, `net` 등을 사용할 수 없습니다. 브라우저 환경입니다.
- **서버 프로세스 없음** — 앱은 포트를 열거나 서버를 실행할 수 없습니다.
- **OAuth 플로우 불가** — OAuth code-for-token 교환에는 서버 측 `client_secret`이 필요합니다. iframe 앱에서는 안전하게 수행할 수 없으므로, API 기반 앱 패턴을 사용하세요 (아래 참조).
- **브라우저 `fetch()`만 가능** — HTTP 요청은 가능하지만 CORS 제한을 받습니다. 많은 API가 직접적인 브라우저 요청을 차단합니다.
- **localStorage/IndexedDB 사용 금지** — `window.yaar.storage`를 사용하세요 (서버 측 저장, 세션 간 유지).
- **자체 완결형** — 앱은 외부 서버, localhost 서비스, iframe 외부 인프라에 의존해서는 안 됩니다.

## 안티패턴

앱 개발 시 피해야 할 일반적인 실수:

- **OAuth 클라이언트를 컴파일된 앱으로 만들지 마세요** — OAuth에는 서버 측 `client_secret` 토큰 교환이 필요합니다. 대신, 사용자가 개인 액세스 토큰(PAT)을 제공하고 `apps_write_config`로 저장하는 API 기반 앱(SKILL.md만)을 만드세요.
- **외부 서버가 실행 중이라고 가정하지 마세요** — `localhost:3000`이나 다른 포트에 백엔드가 없습니다. 앱은 완전히 자체 완결형이어야 합니다.
- **iframe에서 서버 기능을 복제하지 마세요** — 인증이 필요한 외부 API를 호출해야 하면, AI 에이전트가 `http_get`/`http_post` MCP 도구로 HTTP 호출을 처리하고 App Protocol로 데이터를 전달해야 합니다.
- **localhost URL을 하드코딩하지 마세요** — 앱은 YAAR가 서비스되는 어떤 호스트에서든 실행됩니다.

### 외부 서비스 연동의 올바른 패턴

```
옵션 A: API 기반 앱 (API 래퍼에 적합)
  apps/github/SKILL.md → GitHub API, 인증 흐름 기술
  사용자가 PAT 제공 → apps_write_config로 저장
  AI가 http_get/http_post로 GitHub API 호출 → 윈도우에 렌더링

옵션 B: 컴파일된 앱 + AI 매개 API (풍부한 UI용)
  컴파일된 iframe 앱은 UI/표시만 담당
  AI 에이전트가 MCP 도구로 외부 API 호출 처리
  App Protocol이 둘을 연결:
    app_query → AI에서 앱으로 표시 데이터
    app_command → 앱에서 AI로 사용자 액션
```

## 앱 유형

### 컴파일된 앱

AI가 작성 → 컴파일 → 배포한 앱. iframe으로 실행됩니다.

```
apps/falling-blocks/
├── SKILL.md        # 실행 방법 (자동 생성)
├── app.json        # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html      # 컴파일된 단일 HTML
└── src/            # 소스 코드 (keepSource: true)
    └── main.ts
```

### API 기반 앱

외부 API를 호출하는 앱. SKILL.md에 API 사용법을 기술하면 AI가 호출합니다.

```
apps/moltbook/
└── SKILL.md        # API 엔드포인트, 인증 흐름, 워크플로우
```

SKILL.md에 `POST /api/v1/posts`, `GET /feed` 같은 API 목록을 적어두면, "피드 보여줘"라고 할 때 AI가 API를 호출하고 결과를 윈도우에 표시합니다.

### SKILL.md 직접 작성

수동으로 앱을 만들 수도 있습니다. `apps/` 안에 `SKILL.md`만 넣으면 됩니다.

```
apps/weather/
└── SKILL.md    # API 문서, 인증, 워크플로우 등
```

## App Protocol

컴파일된 앱은 **App Protocol**을 통해 AI 에이전트와 양방향 통신할 수 있습니다. 앱이 자신의 기능(상태 조회, 명령)을 매니페스트로 선언하면, 에이전트가 런타임에 이를 발견하고 상태를 읽거나 명령을 실행합니다.

```
에이전트 → MCP 도구 → WebSocket → postMessage → iframe 앱
iframe 앱 → postMessage → WebSocket → MCP 도구 응답
```

### 앱에서 등록하기

`window.yaar.app.register()`로 상태 핸들러와 명령 핸들러를 등록합니다. SDK 스크립트는 iframe에 자동 주입됩니다.

```typescript
window.yaar.app.register({
  appId: 'my-app',
  name: 'My App',
  state: {
    items: {
      description: '현재 아이템 목록',
      handler: () => [...items],
    },
  },
  commands: {
    addItem: {
      description: '아이템 추가. Params: { text: string }',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: (p: { text: string }) => {
        items.push(p.text);
        render();
        return { ok: true };
      },
    },
  },
});
```

### MCP 도구

| 도구 | 설명 |
|------|------|
| `app_query` | 상태 키로 앱의 구조화된 데이터 읽기 (`"manifest"`로 매니페스트 조회) |
| `app_command` | 앱에 명령 실행 |

에이전트는 먼저 `app_query`에 stateKey `"manifest"`를 사용하여 앱이 지원하는 기능을 확인한 뒤, `app_query`와 `app_command`로 상호작용합니다.

### 예시: Excel Lite

```
app_query({ windowId: "excel-lite", stateKey: "manifest" })
app_query({ windowId: "excel-lite", stateKey: "cells" })
app_command({ windowId: "excel-lite", command: "setCells", params: { cells: { "A1": "Hello" } } })
```

## 컴포넌트 파일

`.yaarcomponent.json` 파일을 통해 앱과 함께 재사용 가능한 컴포넌트 레이아웃을 배포할 수 있습니다.

```
compile_component(sandboxId, filename: "dashboard.yaarcomponent.json",
                  components: [...], cols?: [1, 2], gap?: "md")
```

배포 후 AI가 `create_component(jsonfile="{appId}/{filename}")`로 로드할 수 있습니다. `write_json`을 사용하면 이미 배포된 앱에 직접 컴포넌트 파일을 추가할 수도 있습니다.

## 자격 증명 관리

앱 자격 증명은 `config/credentials/{appId}.json`에 저장됩니다 (git-ignored).

```
config/credentials/
└── moltbook.json    # { "api_key": "moltbook_xxx" }
```

- `apps_write_config("moltbook", "credentials.json", { ... })` — 저장
- `apps_read_config("moltbook", "credentials.json")` — 읽기

---

<a id="english"></a>

# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI via MCP tools.

> [한국어 버전](#앱-개발-가이드)

## Development Flow

```
"Make me a Tetris game"

    ↓  AI writes code (write_ts)
    ↓  Compiles (compile) → single HTML file
    ↓  Previews in iframe window
    ↓  Deploys to desktop (deploy)

🎮 Tetris icon appears on the desktop
```

Users don't need to write code. The AI writes TypeScript in a sandbox, compiles with esbuild, previews the result, and deploys it as an app.

## MCP Tools

### App Development Tools

| Tool | Description |
|------|-------------|
| `write_ts` | Write TypeScript files to sandbox |
| `read_ts` | Read sandbox files (omit path to list all files) |
| `apply_diff_ts` | Apply search-and-replace edits to sandbox files |
| `compile` | Bundle `src/main.ts` → single HTML (esbuild) |
| `compile_component` | Create `.yaarcomponent.json` files in sandbox |
| `typecheck` | Run TypeScript type checking on sandbox code |
| `deploy` | Deploy compiled app to desktop |
| `clone` | Clone a deployed app's source into a sandbox for editing |
| `write_json` | Write JSON files directly to a deployed app |

### Code Execution Tools

| Tool | Description |
|------|-------------|
| `run_js` | Execute JavaScript in sandboxed VM |

### Reference Tools

| Tool | Description |
|------|-------------|
| `skill` | Load reference docs by topic (`app_dev`, `sandbox`, `components`, `host_api`, `app_protocol`) |

### App Management Tools

| Tool | Description |
|------|-------------|
| `apps_list` | List apps |
| `apps_load_skill` | Load an app's SKILL.md |
| `apps_read_config` | Read config/source files |
| `apps_write_config` | Write config files |
| `market_list` | List apps available in the marketplace |
| `market_get` | Download and install an app from the marketplace |
| `market_delete` | Uninstall an app and its credentials |

## Development Workflow in Detail

### Step 1: Write Code — `write_ts`

```
write_ts(path: "src/main.ts", content: "...", sandboxId?: "...")
```

- Creates files in an isolated sandbox directory
- Auto-generates `sandboxId` if not provided
- Supports multiple files (`src/main.ts`, `src/utils.ts`, ...)

### Step 2: Compile — `compile`

```
compile(sandboxId: "1739xxx", title?: "My App")
```

- Bundles from `src/main.ts` entry point via esbuild
- Produces a **single self-contained HTML file** with embedded JS
- Returns preview URL: `/api/sandbox/{sandboxId}/dist/index.html`

### Step 3: Preview

The AI opens an iframe window to preview the compiled result immediately.

### Step 4: Deploy — `deploy`

```
deploy(sandboxId: "1739xxx", appId: "my-app", name?: "My App", icon?: "🚀",
       keepSource?: true, skill?: "...", appProtocol?: true,
       fileAssociations?: [{ extensions: [".txt"], command: "openFile", paramKey: "content" }])
```

- Copies compiled HTML to `apps/{appId}/`
- Auto-generates `SKILL.md` and `app.json`
- Icon appears on desktop immediately
- `appProtocol`: Mark app as supporting App Protocol (auto-detected from HTML if not set)
- `fileAssociations`: Map file extensions to app_command calls for file opening

### Editing Existing Apps — `clone` → edit → `compile` → `deploy`

```
clone(appId: "my-app") → returns sandboxId
apply_diff_ts(sandboxId, path, old_string, new_string)  // or write_ts for full replacement
compile(sandbox: sandboxId)
deploy(sandbox: sandboxId, appId: "my-app")  // same appId overwrites in-place
```

## Bundled Libraries

Available via `@bundled/*` imports — no npm install needed:

| Library | Import Path | Purpose |
|---------|------------|---------|
| uuid | `@bundled/uuid` | ID generation |
| lodash | `@bundled/lodash` | Utilities (debounce, cloneDeep, groupBy, etc.) |
| date-fns | `@bundled/date-fns` | Date handling |
| clsx | `@bundled/clsx` | CSS class composition |
| anime.js | `@bundled/anime` | Animation |
| Konva | `@bundled/konva` | 2D canvas graphics |
| Three.js | `@bundled/three` | 3D graphics |
| cannon-es | `@bundled/cannon-es` | 3D physics engine |
| xlsx | `@bundled/xlsx` | Spreadsheet parsing/generation |
| Chart.js | `@bundled/chart.js` | Charts and graphs |
| D3 | `@bundled/d3` | Data visualization |
| Matter.js | `@bundled/matter-js` | 2D physics engine |
| Tone.js | `@bundled/tone` | Audio/music synthesis |
| PixiJS | `@bundled/pixi.js` | 2D WebGL rendering |
| p5.js | `@bundled/p5` | Creative coding |

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

## Sandbox Execution Environment

`run_js` executes code in an isolated VM.

**Available:** JSON, Math, Date, Promise, fetch (domain-restricted), crypto.createHash, TextEncoder/Decoder, typed arrays

**Blocked:** process, require, import, eval, Function, fs, os, setTimeout/setInterval

- Timeout: 100ms–30,000ms (default 5,000ms)
- Allowed fetch domains: managed in `config/curl_allowed_domains.yaml`

## Runtime Constraints

Compiled apps run in a **browser iframe sandbox**. They are subject to these hard constraints:

- **No Node.js APIs** — No `fs`, `process`, `child_process`, `net`, etc. This is a browser environment.
- **No server processes** — Apps cannot listen on ports, spawn servers, or run background daemons.
- **No OAuth flows** — OAuth code-for-token exchange requires a server-side `client_secret`. Iframe apps cannot safely perform this. Use the API-based app pattern instead (see below).
- **Browser `fetch()` only** — Apps can make HTTP requests, but they are subject to CORS restrictions. Many APIs will block direct browser requests.
- **No localStorage/IndexedDB** — Use `window.yaar.storage` for persistence (server-side, survives across sessions).
- **Self-contained** — Apps must not depend on external servers, localhost services, or infrastructure outside the iframe.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `apps_write_config`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `http_get`/`http_post` MCP tools and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via apps_write_config
  AI calls GitHub API via http_get/http_post → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    app_query → display data from AI to app
    app_command → user actions from app to AI
```

## App Types

### Compiled Apps

Built by the AI: write → compile → deploy. Runs in iframe.

```
apps/falling-blocks/
├── SKILL.md        # Launch instructions (auto-generated)
├── app.json        # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html      # Compiled single HTML
└── src/            # Source code (keepSource: true)
    └── main.ts
```

### API-based Apps

Apps that call external APIs. Describe the API in SKILL.md and the AI handles the calls.

```
apps/moltbook/
└── SKILL.md        # API endpoints, auth flow, workflows
```

List APIs like `POST /api/v1/posts`, `GET /feed` in SKILL.md. When a user says "show my feed", the AI calls the API and renders results in a window.

### Manual SKILL.md Apps

You can also create apps manually. Just put a `SKILL.md` in `apps/`.

```
apps/weather/
└── SKILL.md    # API docs, auth, workflows
```

## App Protocol

Compiled apps can communicate bidirectionally with AI agents via the **App Protocol**. Apps declare their capabilities (state queries, commands) in a manifest, and the agent discovers them at runtime to read state or execute commands.

```
Agent → MCP tool → WebSocket → postMessage → Iframe App
Iframe App → postMessage → WebSocket → MCP tool returns
```

### Registering in Your App

Call `window.yaar.app.register()` with state handlers and command handlers. The SDK script is auto-injected into iframes.

```typescript
window.yaar.app.register({
  appId: 'my-app',
  name: 'My App',
  state: {
    items: {
      description: 'Current list of items',
      handler: () => [...items],
    },
  },
  commands: {
    addItem: {
      description: 'Add an item. Params: { text: string }',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: (p: { text: string }) => {
        items.push(p.text);
        render();
        return { ok: true };
      },
    },
  },
});
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `app_query` | Read structured data from app by state key (use `"manifest"` to discover capabilities) |
| `app_command` | Execute a command on the app |

The agent first calls `app_query` with stateKey `"manifest"` to discover capabilities, then uses `app_query` and `app_command` to interact.

### Example: Excel Lite

```
app_query({ windowId: "excel-lite", stateKey: "manifest" })
app_query({ windowId: "excel-lite", stateKey: "cells" })
app_command({ windowId: "excel-lite", command: "setCells", params: { cells: { "A1": "Hello" } } })
```

## Component Files

`.yaarcomponent.json` files let you deploy reusable component layouts alongside apps.

```
compile_component(sandboxId, filename: "dashboard.yaarcomponent.json",
                  components: [...], cols?: [1, 2], gap?: "md")
```

After deploy, the AI can load them via `create_component(jsonfile="{appId}/{filename}")`. Use `write_json` to add component files directly to an already-deployed app.

## Credential Management

App credentials are stored at `config/credentials/{appId}.json` (git-ignored).

```
config/credentials/
└── moltbook.json    # { "api_key": "moltbook_xxx" }
```

- `apps_write_config("moltbook", "credentials.json", { ... })` — save
- `apps_read_config("moltbook", "credentials.json")` — read
