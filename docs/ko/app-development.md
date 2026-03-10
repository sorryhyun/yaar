# 앱 개발 가이드

YAAR에서는 AI에게 말하면 앱이 만들어집니다. TypeScript 작성, 컴파일, 프리뷰, 바탕화면 배포까지 모두 AI가 MCP 도구로 처리합니다.

> [English version](../app-development.md)

## 개발 흐름

```
"테트리스 만들어줘"

    ↓  AI가 코드 작성 (invoke('yaar://sandbox/{path}', { content }))
    ↓  컴파일 (compile) → 단일 HTML 파일
    ↓  iframe 윈도우로 프리뷰
    ↓  바탕화면에 배포 (deploy)

🎮 바탕화면에 테트리스 아이콘 등장
```

사용자는 코드를 직접 작성할 필요가 없습니다. AI가 샌드박스에서 TypeScript를 작성하고, Bun으로 컴파일하고, 프리뷰한 뒤 앱으로 배포합니다. 빌드된 앱은 모든 라이브러리와 코드가 하나의 HTML 파일로 번들링되므로, 별도의 설치 없이 어떤 브라우저에서든 독립적으로 실행할 수 있습니다.

## MCP 도구

### 앱 개발 도구

| 도구 | 설명 |
|------|------|
| `write` | 샌드박스에 TypeScript 파일 작성 (`yaar://sandbox/` URI 사용) |
| `read` | 샌드박스 파일 읽기 (`yaar://sandbox/` URI 사용) |
| `list` | 샌드박스 파일 목록 조회 (`yaar://sandbox/` URI 사용) |
| `edit` | 샌드박스 파일 검색-치환 편집 (`yaar://sandbox/` URI 사용) |
| `compile` | `src/main.ts` → 단일 HTML로 번들 (Bun) |
| `typecheck` | 샌드박스 TypeScript 타입 검사 |
| `deploy` | 컴파일된 앱을 바탕화면에 배포 |
| `clone` | 배포된 앱의 소스를 샌드박스로 복제 (편집용) |

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
| `invoke('yaar://config/app/{appId}', { config })` | 앱 설정 저장 |
| `read('yaar://config/app/{appId}')` | 앱 설정 읽기 |
| `delete('yaar://config/app/{appId}')` | 앱 설정 삭제 |
| `market_list` | 마켓플레이스 앱 목록 조회 |
| `market_get` | 마켓플레이스에서 앱 설치 |
| `market_delete` | 설치된 앱 삭제 |

## 개발 워크플로우 상세

### 1단계: 코드 작성 — `write`

```
write(uri: "yaar://sandbox/src/main.ts", content: "...")        // 새 샌드박스 자동 생성
write(uri: "yaar://sandbox/1739xxx/src/main.ts", content: "...") // 기존 샌드박스에 추가
```

- 격리된 샌드박스 디렉토리에 파일 생성
- `sandboxId` 미지정 시 자동 생성
- 여러 파일 작성 가능 (`src/main.ts`, `src/utils.ts`, ...)

### 2단계: 컴파일 — `compile`

```
compile(sandboxId: "1739xxx", title?: "My App")
```

- `src/main.ts`를 진입점으로 Bun 번들링
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
edit(uri: "yaar://sandbox/{sandboxId}/path", old_string, new_string)  // 또는 write로 전체 교체
compile(sandbox: sandboxId)
deploy(sandbox: sandboxId, appId: "my-app")  // 동일 appId로 덮어쓰기
```

## 번들 라이브러리

npm 설치 없이 `@bundled/*`로 바로 사용 가능:

| 라이브러리 | import 경로 | 용도 |
|-----------|------------|------|
| solid-js | `@bundled/solid-js` | 반응형 UI (createSignal, createEffect, Show, For 등) |
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

## TypeScript 주의 사항

모든 앱의 `src/main.ts`는 파일 상단에 `export {};`를 포함해야 합니다. `apps/tsconfig.json`이 모든 앱을 하나의 프로그램으로 컴파일하기 때문에, 이 구문이 없으면 TypeScript가 파일을 스크립트로 인식하여 앱 간 최상위 변수가 충돌합니다.

```typescript
export {};

import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';

const [count, setCount] = createSignal(0);
render(() => html`<button onClick=${() => setCount(c => c + 1)}>Clicked ${() => count()} times</button>`, document.getElementById('app')!);
```

`@bundled/*` 라이브러리를 import하는 경우 이미 모듈로 인식되므로 별도 추가 불필요.

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

- **OAuth 클라이언트를 컴파일된 앱으로 만들지 마세요** — OAuth에는 서버 측 `client_secret` 토큰 교환이 필요합니다. 대신, 사용자가 개인 액세스 토큰(PAT)을 제공하고 `invoke('yaar://config/app/{appId}', { config })`로 저장하는 API 기반 앱(SKILL.md만)을 만드세요.
- **외부 서버가 실행 중이라고 가정하지 마세요** — `localhost:3000`이나 다른 포트에 백엔드가 없습니다. 앱은 완전히 자체 완결형이어야 합니다.
- **iframe에서 서버 기능을 복제하지 마세요** — 인증이 필요한 외부 API를 호출해야 하면, AI 에이전트가 `http_get`/`http_post` 시스템 도구로 HTTP 호출을 처리하고 App Protocol로 데이터를 전달해야 합니다.
- **localhost URL을 하드코딩하지 마세요** — 앱은 YAAR가 서비스되는 어떤 호스트에서든 실행됩니다.

### 외부 서비스 연동의 올바른 패턴

```
옵션 A: API 기반 앱 (API 래퍼에 적합)
  apps/github/SKILL.md → GitHub API, 인증 흐름 기술
  사용자가 PAT 제공 → invoke('yaar://config/app/{appId}', { config })로 저장
  AI가 http_get/http_post로 GitHub API 호출 → 윈도우에 렌더링

옵션 B: 컴파일된 앱 + AI 매개 API (풍부한 UI용)
  컴파일된 iframe 앱은 UI/표시만 담당
  AI 에이전트가 MCP 도구로 외부 API 호출 처리
  App Protocol이 둘을 연결:
    invoke(uri, { action: 'app_query' }) → AI에서 앱으로 표시 데이터
    invoke(uri, { action: 'app_command' }) → 앱에서 AI로 사용자 액션
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
    ├── main.ts
    └── styles.css
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
// src/protocol.ts
import { items } from './store';

export function registerProtocol() {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
    appId: 'my-app',
    name: 'My App',
    state: {
      items: {
        description: '현재 아이템 목록',
        handler: () => [...items()],  // 시그널 읽기, 복사본 반환
      },
    },
    commands: {
      addItem: {
        description: '아이템 추가. Params: { text: string }',
        params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: (p: { text: string }) => {
          items([...items(), p.text]);  // 불변 시그널 쓰기, render() 불필요
          return { ok: true };
        },
      },
    },
  });
}
```

### MCP 도구

| 도구 | 설명 |
|------|------|
| `invoke('yaar://windows/{id}', { action: 'app_query', key })` | 상태 키로 앱의 구조화된 데이터 읽기 (`"manifest"`로 매니페스트 조회) |
| `invoke('yaar://windows/{id}', { action: 'app_command', command, params })` | 앱에 명령 실행 |

에이전트는 먼저 `app_query`에 bare window URI를 사용하여 앱이 지원하는 기능(매니페스트)을 확인한 뒤, `app_query`와 `app_command`로 상호작용합니다.

### 예시: Excel Lite

```
invoke('yaar://windows/excel-lite', { action: 'app_query' })
invoke('yaar://windows/excel-lite', { action: 'app_query', key: 'cells' })
invoke('yaar://windows/excel-lite', { action: 'app_command', command: 'setCells', params: { cells: { "A1": "Hello" } } })
```

## 자격 증명 관리

앱 설정/자격 증명은 `config/{appId}.json`에 저장됩니다 (git-ignored).

```
config/
└── moltbook.json    # { "api_key": "moltbook_xxx" }
```

- `invoke('yaar://config/app/moltbook', { config: { api_key: "..." } })` — 저장
- `read('yaar://config/app/moltbook')` — 읽기
- `delete('yaar://config/app/moltbook')` — 삭제
