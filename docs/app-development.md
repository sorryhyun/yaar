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
| `compile` | `src/main.ts` → 단일 HTML로 번들 (esbuild) |
| `deploy` | 컴파일된 앱을 바탕화면에 배포 |

### 코드 실행 도구

| 도구 | 설명 |
|------|------|
| `run_js` | JavaScript를 샌드박스 VM에서 실행 |
| `run_ts` | TypeScript를 컴파일 후 샌드박스 VM에서 실행 |

### 앱 관리 도구

| 도구 | 설명 |
|------|------|
| `apps_list` | 앱 목록 조회 |
| `apps_load_skill` | 앱의 SKILL.md 로드 |
| `apps_read_config` | 설정/소스 파일 읽기 |
| `apps_write_config` | 설정 파일 쓰기 |

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
deploy(sandboxId: "1739xxx", appId: "my-app", name?: "My App", icon?: "🚀", keepSource?: true)
```

- 컴파일된 HTML을 `apps/{appId}/`로 복사
- `SKILL.md`와 `app.json` 자동 생성
- 바탕화면에 아이콘 즉시 등장

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

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

## 샌드박스 실행 환경

`run_js`/`run_ts`는 격리된 VM에서 코드를 실행합니다.

**사용 가능:** JSON, Math, Date, Promise, fetch (도메인 제한), crypto.createHash, TextEncoder/Decoder, 타입 배열

**차단됨:** process, require, import, eval, Function, fs, os, setTimeout/setInterval

- 타임아웃: 100ms ~ 30,000ms (기본 5,000ms)
- fetch 허용 도메인: `config/curl_allowed_domains.yaml`에서 관리

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
| `compile` | Bundle `src/main.ts` → single HTML (esbuild) |
| `deploy` | Deploy compiled app to desktop |

### Code Execution Tools

| Tool | Description |
|------|-------------|
| `run_js` | Execute JavaScript in sandboxed VM |
| `run_ts` | Compile and execute TypeScript in sandboxed VM |

### App Management Tools

| Tool | Description |
|------|-------------|
| `apps_list` | List apps |
| `apps_load_skill` | Load an app's SKILL.md |
| `apps_read_config` | Read config/source files |
| `apps_write_config` | Write config files |

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
deploy(sandboxId: "1739xxx", appId: "my-app", name?: "My App", icon?: "🚀", keepSource?: true)
```

- Copies compiled HTML to `apps/{appId}/`
- Auto-generates `SKILL.md` and `app.json`
- Icon appears on desktop immediately

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

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

## Sandbox Execution Environment

`run_js`/`run_ts` execute code in an isolated VM.

**Available:** JSON, Math, Date, Promise, fetch (domain-restricted), crypto.createHash, TextEncoder/Decoder, typed arrays

**Blocked:** process, require, import, eval, Function, fs, os, setTimeout/setInterval

- Timeout: 100ms–30,000ms (default 5,000ms)
- Allowed fetch domains: managed in `config/curl_allowed_domains.yaml`

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

## Credential Management

App credentials are stored at `config/credentials/{appId}.json` (git-ignored).

```
config/credentials/
└── moltbook.json    # { "api_key": "moltbook_xxx" }
```

- `apps_write_config("moltbook", "credentials.json", { ... })` — save
- `apps_read_config("moltbook", "credentials.json")` — read
