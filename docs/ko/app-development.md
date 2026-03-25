# 앱 개발 가이드

YAAR에서는 AI에게 말하면 앱이 만들어집니다. TypeScript 작성, 컴파일, 프리뷰, 바탕화면 배포까지 모두 AI가 devtools 앱을 통해 처리합니다.

> [English version](../app-development.md)

## 개발 흐름

```
"테트리스 만들어줘"

    ↓  AI가 devtools 앱 윈도우를 열고
    ↓  App Protocol 명령으로 코드 작성
    ↓  devtools 컴파일 명령으로 컴파일
    ↓  iframe 윈도우로 프리뷰
    ↓  devtools 배포 명령으로 바탕화면에 배포

🎮 바탕화면에 테트리스 아이콘 등장
```

사용자는 코드를 직접 작성할 필요가 없습니다. AI가 devtools 앱을 통해 TypeScript를 작성하고, Bun으로 컴파일하고, 프리뷰한 뒤 앱으로 배포합니다. 빌드된 앱은 모든 라이브러리와 코드가 하나의 HTML 파일로 번들링되므로, 별도의 설치 없이 어떤 브라우저에서든 독립적으로 실행할 수 있습니다.

## URI 동사

모든 작업은 5개의 범용 동사(`read`, `list`, `invoke`, `delete`, `describe`)를 `yaar://` URI에 적용하여 수행합니다.

### Devtools 앱

앱 개발(작성, 편집, 컴파일, 타입 검사, 배포, 복제)은 **devtools 앱**을 통해 App Protocol 명령으로 처리됩니다. devtools 앱은 iframe 윈도우에서 실행되며, 이러한 작업을 프로토콜 명령으로 제공합니다. AI가 devtools 윈도우를 열고 `app_command`와 `app_query`로 상호작용합니다.

사용 가능한 명령의 전체 목록은 devtools 앱의 `SKILL.md`를 참조하세요.

### 앱 — `yaar://apps/`

| 동사 | URI | 설명 |
|------|-----|------|
| `list` | `yaar://apps` | 설치된 앱 전체 목록 조회 |
| `read` | `yaar://apps/{appId}` | 앱의 SKILL.md 로드 |
| `invoke` | `yaar://apps/{appId}`, `{ action: "set_badge", count }` | 앱 아이콘 배지 설정 |
| `delete` | `yaar://apps/{appId}` | 앱 삭제 |

### 앱 설정 — `yaar://config/app/`

| 동사 | URI | 설명 |
|------|-----|------|
| `invoke` | `yaar://config/app/{appId}`, `{ config }` | 앱 설정/자격 증명 저장 |
| `read` | `yaar://config/app/{appId}` | 앱 설정 읽기 |
| `delete` | `yaar://config/app/{appId}` | 앱 설정 삭제 |

### 마켓플레이스 — `yaar://market/`

| 동사 | URI | 설명 |
|------|-----|------|
| `list` | `yaar://market` | 마켓플레이스 앱 목록 조회 |
| `read` | `yaar://market/{appId}` | 마켓플레이스 앱 상세 정보 |
| `invoke` | `yaar://market/{appId}`, `{ action: "install" }` | 마켓플레이스에서 앱 설치 |

### 스킬 — `yaar://skills/`

| 동사 | URI | 설명 |
|------|-----|------|
| `list` | `yaar://skills` | 사용 가능한 스킬 토픽 목록 |
| `read` | `yaar://skills/{topic}` | 참조 문서 로드 (`app_dev`, `components`, `host_api`, `app_protocol`) |

## 개발 워크플로우 상세

모든 개발 작업은 **devtools 앱**을 통해 App Protocol 명령으로 수행됩니다. AI가 devtools 윈도우를 열고 `app_command`로 코드 작성, 컴파일, 배포를 진행합니다.

### 1단계: 코드 작성

AI가 devtools 앱에 write/edit 명령을 보내 소스 파일을 생성합니다.

- 여러 파일 작성 가능 (`src/main.ts`, `src/utils.ts`, ...)

### 2단계: 컴파일

AI가 devtools 앱에 compile 명령을 보냅니다.

- `src/main.ts`를 진입점으로 Bun 번들링
- JS가 내장된 **단일 HTML 파일** 생성
- `/api/dev/` 경로를 통해 프리뷰 URL 반환

### 3단계: 프리뷰

AI가 iframe 윈도우를 열어 컴파일 결과를 바로 확인합니다.

### 4단계: 배포

AI가 devtools 앱에 deploy 명령을 보냅니다.

- 컴파일된 HTML을 `apps/{appId}/`로 복사
- `SKILL.md`와 `app.json` 자동 생성
- 바탕화면에 아이콘 즉시 등장
- `appProtocol`: App Protocol 지원 여부 (HTML에서 자동 감지, 수동 설정 가능)
- `fileAssociations`: 앱이 열 수 있는 파일 확장자 매핑

### 기존 앱 수정 — clone → 편집 → compile → deploy

AI가 기존 앱의 소스를 devtools 워크스페이스로 복제하고, 편집 후 다시 컴파일하여 동일한 appId로 재배포합니다.

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

### 게이트 SDK

일부 `@bundled/*` SDK는 `app.json`의 `"bundles"` 필드에 명시적으로 선언해야 사용할 수 있습니다. 선언하지 않으면 컴파일러가 import를 거부합니다.

| SDK | Import 경로 | 용도 | 필요한 `bundles` 값 |
|-----|------------|------|-------------------|
| Dev Tools | `@bundled/yaar-dev` | `compile()`, `typecheck()`, `deploy()`, `bundledLibraries()` | `"yaar-dev"` |
| Browser | `@bundled/yaar-web` | `open()`, `click()`, `type()`, `extract()` 등 | `"yaar-web"` |

**app.json:**
```json
{
  "bundles": ["yaar-dev"],
  "permissions": ["yaar://storage/", "yaar://apps/"]
}
```

**사용 예시:**
```typescript
import { compile, typecheck, deploy } from '@bundled/yaar-dev';
import { open, click, extract } from '@bundled/yaar-web';
```

기본 `@bundled/yaar` SDK(verb, storage, app protocol, 유틸리티)는 모든 앱에서 선언 없이 사용할 수 있습니다.

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
- **브라우저 `fetch()`는 CORS 제한** — 직접적인 크로스 오리진 요청은 차단됩니다. `yaar.invoke('yaar://http', { url, ... })`를 사용하여 서버를 통해 프록시하세요.
- **localStorage/IndexedDB 사용 금지** — `@bundled/yaar`의 `appStorage`를 사용하세요 (서버 측 저장, 세션 간 유지).
- **자체 완결형** — 앱은 외부 서버, localhost 서비스, iframe 외부 인프라에 의존해서는 안 됩니다.

## 안티패턴

앱 개발 시 피해야 할 일반적인 실수:

- **OAuth 클라이언트를 컴파일된 앱으로 만들지 마세요** — OAuth에는 서버 측 `client_secret` 토큰 교환이 필요합니다. 대신, 사용자가 개인 액세스 토큰(PAT)을 제공하고 `invoke('yaar://config/app/{appId}', { config })`로 저장하는 API 기반 앱(SKILL.md만)을 만드세요.
- **외부 서버가 실행 중이라고 가정하지 마세요** — `localhost:3000`이나 다른 포트에 백엔드가 없습니다. 앱은 완전히 자체 완결형이어야 합니다.
- **iframe에서 서버 기능을 복제하지 마세요** — 인증이 필요한 외부 API를 호출해야 하면, AI 에이전트가 `invoke('yaar://http', { url, method?, headers?, body? })`로 HTTP 호출을 처리하고 App Protocol로 데이터를 전달해야 합니다.
- **localhost URL을 하드코딩하지 마세요** — 앱은 YAAR가 서비스되는 어떤 호스트에서든 실행됩니다.

### 외부 서비스 연동의 올바른 패턴

```
옵션 A: API 기반 앱 (API 래퍼에 적합)
  apps/github/SKILL.md → GitHub API, 인증 흐름 기술
  사용자가 PAT 제공 → invoke('yaar://config/app/{appId}', { config })로 저장
  AI가 invoke('yaar://http', ...)로 GitHub API 호출 → 윈도우에 렌더링

옵션 B: 컴파일된 앱 + AI 매개 API (풍부한 UI용)
  컴파일된 iframe 앱은 UI/표시만 담당
  AI 에이전트가 MCP 도구로 외부 API 호출 처리
  App Protocol이 둘을 연결:
    invoke(uri, { action: 'app_query' }) → AI에서 앱으로 표시 데이터
    invoke(uri, { action: 'app_command' }) → 앱에서 AI로 사용자 액션
```

## 에이전트 프롬프트 커스터마이징

각 앱은 사용자가 상호작용할 때 전용 **앱 에이전트**를 생성합니다. 에이전트의 시스템 프롬프트는 앱 디렉토리의 파일로부터 빌드됩니다:

| 파일 | 역할 | 사용 시점 |
|------|------|-----------|
| `SKILL.md` | 범용 기본 프롬프트에 추가 | 대부분의 앱 — API 문서, 사용법, 도메인 컨텍스트 추가 |
| `AGENTS.md` | 범용 기본 프롬프트를 **완전히 대체** | 정밀한 에이전트 동작이 필요한 앱 (예: devtools IDE) |

**우선순위:** `AGENTS.md` > `SKILL.md`. 둘 다 있으면 `AGENTS.md`만 사용됩니다. `protocol.json` 매니페스트(사용 가능한 state 키와 command)는 어떤 경우든 항상 추가됩니다.

### SKILL.md (기본)

에이전트가 범용 프롬프트("당신은 X 앱의 AI 어시스턴트입니다...")를 받고, `SKILL.md` 내용이 "App Documentation" 제목 아래 추가됩니다. 기본 3-tool 동작(query, command, relay)이 충분하고 도메인 지식만 추가하면 되는 앱에 적합합니다.

### AGENTS.md (완전 제어)

에이전트의 전체 시스템 프롬프트가 `AGENTS.md`의 내용으로 대체됩니다. 다음과 같은 경우에 사용하세요:
- 에이전트에 특정 워크플로우가 필요한 경우 (예: devtools의 타입체크 → 컴파일 → 배포)
- 안티패턴, 주의사항, 도메인 특화 규칙을 정의해야 하는 경우
- 범용 프롬프트의 동작 가이드라인이 맞지 않는 경우

`AGENTS.md`는 기본 프롬프트를 대체하므로, 에이전트가 사용할 수 있는 3가지 도구(`query`, `command`, `relay`)를 직접 문서화해야 합니다.

### 예시 구조

```
apps/my-app/
├── AGENTS.md       # 완전한 커스텀 에이전트 프롬프트 (선택, 고급)
├── SKILL.md        # 앱 문서 (선택, 간단)
├── app.json        # 메타데이터, 권한, 프로토콜 매니페스트
├── index.html      # 컴파일된 앱 (컴파일된 경우)
└── src/            # 소스 코드 (컴파일된 경우)
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

`@bundled/yaar`에서 `app`을 import하고 `app.register()`로 상태 핸들러와 명령 핸들러를 등록합니다.

```typescript
// src/protocol.ts
import { app } from '@bundled/yaar';
import { items } from './store';

export function registerProtocol() {
  app.register({
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
| `invoke('yaar://windows/{id}', { action: 'message', message })` | 앱 에이전트에 메시지 전송 (모니터 → 앱 에이전트 위임). Fire-and-forget — 사용자 상호작용과 동일한 코드 경로. |

에이전트는 먼저 `app_query`에 bare window URI를 사용하여 앱이 지원하는 기능(매니페스트)을 확인한 뒤, `app_query`와 `app_command`로 상호작용합니다.

`message` 액션은 **모니터 에이전트가 앱 에이전트에 작업을 위임**할 수 있게 합니다. `AppTaskProcessor`를 통해 사용자 `WINDOW_MESSAGE`와 동일한 경로로 태스크를 큐잉하며, 필요시 앱 에이전트를 자동 생성합니다. `subscribe`와 결합하면 앱 에이전트 작업 완료 알림을 받을 수 있습니다.

### 예시: Excel Lite

```
invoke('yaar://windows/excel-lite', { action: 'app_query' })
invoke('yaar://windows/excel-lite', { action: 'app_query', key: 'cells' })
invoke('yaar://windows/excel-lite', { action: 'app_command', command: 'setCells', params: { cells: { "A1": "Hello" } } })
invoke('yaar://windows/excel-lite', { action: 'message', message: 'A열을 요약해줘' })
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

## 앱 전용 스토리지

각 앱은 `storage/apps/{appId}/`에 격리된 파일 저장소를 가집니다. 앱 코드에서는 `self`를 약칭으로 사용할 수 있으며, 서버가 iframe 토큰에서 실제 appId로 변환합니다.

### 앱 코드에서 (`@bundled/yaar`)

```typescript
import { appStorage } from '@bundled/yaar';

// 파일 저장
await appStorage.save('data.json', JSON.stringify({ key: 'value' }));

// JSON으로 읽기
const data = await appStorage.readJson<{ key: string }>('data.json');

// 텍스트로 읽기
const text = await appStorage.read('data.json');

// 바이너리 읽기 (returns { data: base64, mimeType })
const binary = await appStorage.readBinary('image.png');

// 파일 목록 (returns [{ path, isDirectory, size, modifiedAt }])
const files = await appStorage.list();

// 파일 삭제
await appStorage.remove('data.json');
```

### 에이전트에서 (MCP 도구)

```
invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })
read('yaar://apps/my-app/storage/data.json')
list('yaar://apps/my-app/storage/')
delete('yaar://apps/my-app/storage/data.json')
```
