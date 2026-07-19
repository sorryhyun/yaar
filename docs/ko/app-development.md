# 앱 개발 가이드

YAAR에서는 AI에게 말하면 앱이 만들어집니다. TypeScript 작성, 컴파일, 프리뷰, 바탕화면 배포까지 모두 AI가 devtools 앱을 통해 처리합니다.

> [English version](../guides/app-development.md)

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

### 스킬 — `yaar://skills/`

| 동사 | URI | 설명 |
|------|-----|------|
| `list` | `yaar://skills` | 사용 가능한 스킬 토픽 목록 |
| `read` | `yaar://skills/{topic}` | 참조 문서 로드 (`components`, `config`, `marketplace`) |

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
| solid-js/html | `@bundled/solid-js/html` | `html` 태그드 템플릿 (JSX 미사용) |
| solid-js/web | `@bundled/solid-js/web` | `render`, DOM 헬퍼 |
| solid-js/store | `@bundled/solid-js/store` | 중첩 반응형 스토어 (`createStore`) |
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
| marked | `@bundled/marked` | 마크다운 → HTML |
| Prism | `@bundled/prismjs` | 구문 강조 |
| DOMPurify | `@bundled/dompurify` | HTML 새니타이즈 (외부 리치 콘텐츠에 필수) |
| mammoth | `@bundled/mammoth` | `.docx` → HTML |
| diff | `@bundled/diff` | 텍스트 diff |
| diff2html | `@bundled/diff2html` | diff 렌더링 뷰 |

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
| ML 런타임 | `@bundled/yaar-ml` | 브라우저 내 모델 추론 (WebGPU/wasm): `session()`, `run()`, `capabilities()`, `fetchWeights()` | `"yaar-ml"` |

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
- **크로스 오리진 HTTP는 프록시 경유** — `@bundled/yaar`의 `httpFetch`를 사용하고 `app.json`에 `yaar://http`를 선언하세요. [HTTP 요청하기](#http-요청하기)를 참조하세요.
- **localStorage/IndexedDB 사용 금지** — `@bundled/yaar`의 `appStorage`를 사용하세요 (서버 측 저장, 세션 간 유지).
- **자체 완결형** — 앱은 외부 서버, localhost 서비스, iframe 외부 인프라에 의존해서는 안 됩니다.

## 신뢰할 수 없는 HTML 렌더링

앱이 직접 작성하지 않은 HTML — 스토리지에서 읽은 마크다운, 스크래핑한 페이지, RSS 피드
본문, GitHub README, `appStorage` 를 거쳐 되돌아온 콘텐츠 — 은 DOM 에 닿기 전에 반드시
`@bundled/dompurify` 를 통과해야 합니다. 앱은 iframe 안에서 실행되지만, 그 iframe 은 앱
자신의 스토리지, 자격 증명, 에이전트와의 프로토콜 채널을 쥐고 있습니다. 주입된 스크립트는
그 전부를 장악합니다.

모든 리치 콘텐츠 파이프라인은 다음 순서를 따릅니다:

1. 마크다운 또는 원본 콘텐츠를 파싱한다;
2. **완성된 프래그먼트를 새니타이즈한다**;
3. 새니타이즈된 프래그먼트에 앱 고유의 DOM 재작성을 수행한다;
4. 결과를 삽입한다;
5. 인라인 이벤트 속성이 아니라 이벤트 리스너로 동작을 연결한다.

```typescript
import DOMPurify from '@bundled/dompurify';

const clean = DOMPurify.sanitize(marked.parse(source) as string);
const doc = new DOMParser().parseFromString(clean, 'text/html');
rewriteRelativeLinks(doc);       // 이미 안전한 HTML 위에서 도는 앱 로직
el.innerHTML = doc.body.innerHTML;
attachImageFallbacks(el);        // 삽입 후 addEventListener
```

2번과 3번의 순서에는 이유가 있습니다. 먼저 새니타이즈하면 안전하지 않은 원본 속성이 재작성
단계까지 살아남지 못하고, 그 뒤에 재작성하면 기본 정책을 약화시키지 않고도 앱이 안전하다고
아는 URL 과 속성을 만들어 넣을 수 있습니다. 순서를 뒤집으면 재작성 코드가 공격자가 통제하는
입력을 받게 됩니다.

5번도 그만큼 중요합니다. DOMPurify 는 `onerror`/`onload`/`onclick` 을 무조건 제거하므로,
`img.setAttribute('onerror', '...')` 로 만든 폴백은 새니타이저를 도입하는 순간 조용히
동작을 멈춥니다. 대신 삽입된 노드에 실제
`addEventListener('error', handler, { once: true })` 를 등록하세요.

파이프라인당 한 곳에서만 새니타이즈하세요. 외부 콘텐츠가 앱 상태로 처음 들어오는 지점이
가장 좋습니다. 그래야 하위의 모든 싱크가 구조적으로 안전해집니다. 정책이 두 겹으로 겹치는
것은 한 겹보다 나쁩니다 — 다음 편집자가 다른 쪽이 막아준다고 믿고 한쪽을 느슨하게 만듭니다.

옵션 없는 `DOMPurify.sanitize(dirty)` 가 기본 정책이며, OS 셸의 마크다운/HTML 렌더러와
동일합니다. 콘텐츠 종류가 정말로 다른 허용 목록을 필요로 할 때만 — 인쇄용 문서는 산문
렌더링에 필요 없는 인라인 `style` 이 필요합니다 — 옵션 객체를 넘기고, 그 이유를 옆에
주석으로 남기세요.

새니타이저를 직접 만들지 마세요. 엘리먼트 차단 목록과 `^on` 속성 제거는 `<svg>`/`<math>`
뮤테이션 XSS, `srcset`, `formaction`, `xlink:href` 를 놓칩니다.

### 새니타이저가 동작하는 것처럼 보이게 만드는 두 가지 함정

**`USE_PROFILES` 는 `ALLOWED_TAGS` 와 교집합을 이루지 않고 덮어씁니다.** 이미 명시적인
`ALLOWED_TAGS` 목록이 있는 설정에 `USE_PROFILES: { html: true }` 를 추가하면, 그 목록이
DOMPurify 의 훨씬 넓은 HTML 프로필로 *교체*됩니다. 더 엄격해 보이는 정책이 어느 순간
`<form action="//evil"><input name=pw>` 를 조용히 통과시키게 됩니다. 명시적인
`ALLOWED_TAGS` 가 있다면 그것만으로 이미 출력이 해당 태그로 제한됩니다 — SVG 와 MathML
엘리먼트는 구조적으로 존재할 수 없습니다.

**새니타이저는 jsdom 이나 실제 브라우저에서 테스트하고, happy-dom 은 절대 쓰지 마세요.**
DOMPurify 는 `isSupported` 를 확인해 호스트 DOM 이 불완전하면 조용히 no-op 이 됩니다.
그래서 happy-dom 에서는 `javascript:` href 가 그대로 통과하는 동시에 happy-dom 자체 파서가
멀쩡한 `<table>`/`<ul>`/`<pre>` 래퍼를 제거합니다. 한 번의 실행에서 거짓 통과와 거짓 실패가
동시에 나오는 셈이고, 초록불로 보이지만 아무것도 증명하지 못하는 테스트가 됩니다.

살아남으면 안 되는 것(`<script>`, `<iframe>`, `<object>`, `<form>`, SVG 로 감싼 script,
`javascript:` URL, 인라인 `on*=`)**과** 반드시 살아남아야 하는 것(표, 코드 블록, 이미지,
링크)을 **모두** 검증하세요. 전부 제거하는 새니타이저는 앞쪽 목록만은 완벽하게 통과합니다.

## HTTP 요청하기

`@bundled/yaar` 의 `httpFetch` 를 사용하고, `app.json` 에 `yaar://http` 를 선언하세요.

```typescript
import { httpFetch } from '@bundled/yaar';

const res = await httpFetch('https://api.example.com/items?page=2');
if (!res.ok) throw new Error(`요청 실패: ${res.status}`);
const items = await res.json();
```

`fetch` 그 자체입니다. 표준 `Response` 를 받으므로 `json()`, `text()`, `blob()`,
`arrayBuffer()` 와 실제 `Headers` 를 그대로 쓸 수 있고(따라서 업스트림의 rate-limit·세션
헤더도 읽을 수 있습니다), 바이너리 본문도 손상 없이 전달됩니다.

플랫폼이 내부에서 하는 일:

| | 크로스 오리진 | 동일 오리진 / 상대 경로 |
|---|---|---|
| 경로 | YAAR 서버 측 프록시 | iframe 토큰을 실어 직접 요청 |
| CORS | 해당 없음 — 서버가 대신 호출 | 일반 브라우저 규칙 |
| `yaar://http` 필요 | 예 | 아니오 |
| 쿠키 | (세션, 앱) 범위의 쿠키 저장소 | iframe 자체 쿠키 |

크로스 오리진 요청에는 SSRF 검증, 도메인 허용 목록(새 도메인마다 사용자에게 한 번 확인),
10 MB 응답 제한, 30초 타임아웃이 함께 적용됩니다. `redirect: 'manual'` 은 지원되며,
`redirect: 'error'` 는 표현할 수 없어 `'follow'` 로 처리됩니다.

**권한을 선언하세요.** `app.json` 의 `permissions` 에 `"yaar://http"` 가 없으면 크로스
오리진 요청은 403 으로 거부됩니다. `"yaar://http"` 와 `"yaar://http/"` 둘 다 동작합니다.

```json
{ "permissions": ["yaar://apps/self/storage/", "yaar://http"] }
```

**`invoke('yaar://http', …)` 보다 `httpFetch` 를 쓰세요.** verb 형태는 `Response` 가 아니라
YAAR 내부 응답 봉투를 반환하며, 이를 사용한 앱들은 결국 그 봉투 타입을 각자 부분적으로
다시 선언했습니다 — 하나의 업스트림 계약에 대해 서로 호환되지 않는 네 가지가 저장소에
생겼습니다. verb 형태는 패치할 `window.fetch` 가 없는 에이전트 측 코드용으로 남겨두세요.

**로그인이 있는 앱이라면 로그아웃 시 쿠키 저장소를 비우세요.** 프록시가 저장한 쿠키는
(세션, 앱) 키로 서버 측에 남으며, iframe 토큰이 만료되기 전까지 아무것도 이를 지우지
않습니다. 따라서 앱이 보관한 세션만 지우면 겉보기에만 로그아웃된 상태가 되고, 이후 요청은
계속 업스트림 세션을 실어 나릅니다.

```typescript
import { del } from '@bundled/yaar';

export async function logout() {
  await clearMyStoredSession();
  await del('yaar://http');   // 이 앱의 프록시 쿠키를 삭제
}
```

`del('yaar://http')` 은 호출한 앱 자신의 저장소만 비웁니다. 키는 payload 가 아니라 호출자의
토큰에서 유도되므로, 한 앱이 다른 앱을 로그아웃시킬 수 없습니다.

페이지네이션, rate limit, JSON-RPC 프레이밍, 인증 갱신 같은 서비스별 관심사는 앱에
남습니다. `httpFetch` 는 전송 계층만 표준화합니다.

## 안티패턴

앱 개발 시 피해야 할 일반적인 실수:

- **OAuth 클라이언트를 컴파일된 앱으로 만들지 마세요** — OAuth에는 서버 측 `client_secret` 토큰 교환이 필요합니다. 대신, 사용자가 개인 액세스 토큰(PAT)을 제공하고 `invoke('yaar://config/app/{appId}', { config })`로 저장하는 API 기반 앱(SKILL.md만)을 만드세요.
- **외부 서버가 실행 중이라고 가정하지 마세요** — `localhost:3000`이나 다른 포트에 백엔드가 없습니다. 앱은 완전히 자체 완결형이어야 합니다.
- **프록시 응답 봉투를 직접 정의하지 마세요** — `httpFetch` 와 그것이 반환하는 표준 `Response` 를 쓰세요. `invoke('yaar://http')` 주위에 `{ ok, status, body }` 인터페이스를 직접 선언하는 것은 소유하지 않은 내부 계약을 다시 타이핑하는 일입니다. [HTTP 요청하기](#http-요청하기) 참고.
- **localhost URL을 하드코딩하지 마세요** — 앱은 YAAR가 서비스되는 어떤 호스트에서든 실행됩니다.
- **저장 실패를 삼키지 마세요** — `appStorage.save()` 를 `catch { /* ignore */ }` 로 감싸면 UI는 "저장됨"이라고 표시한 채 데이터가 조용히 사라집니다. `appStorage.trySave()` 를 쓰고 그 결과에 따라 성공 UI를 표시하세요. [저장 실패를 삼키지 마세요](#저장-실패를-삼키지-마세요) 참고.
- **SDK 헬퍼를 다시 구현하지 마세요** — `errMsg`, `showToast`, `showAlert`, `showConfirm`, `showPrompt`, `withLoading`, `wait` 는 `@bundled/yaar` 가, `debounce` 는 `@bundled/lodash` 가 제공합니다. 네이티브 `alert()`/`confirm()`/`prompt()` 는 페이지(그리고 브라우저를 조작 중인 에이전트)를 블로킹하므로 쓰지 마세요.
- **새니타이즈하지 않은 HTML 을 `innerHTML` 에 넣지 마세요** — `marked.parse()` 는 원본 HTML 을 이스케이프하지 않으며, RSS 피드나 스크래핑한 페이지, 스토리지에서 읽은 파일도 마찬가지입니다. 먼저 `@bundled/dompurify` 를 통과시키세요. [신뢰할 수 없는 HTML 렌더링](#신뢰할-수-없는-html-렌더링) 참고.
- **새니타이저를 직접 만들지 마세요** — 엘리먼트 차단 목록에 `^on` 속성 제거를 더하면 완전해 보이지만 그렇지 않습니다. `<svg>`/`<math>` 뮤테이션 XSS, `style`, `srcset`, `formaction`, `xlink:href` 를 놓칩니다.
- **인라인 이벤트 속성을 생성하지 마세요** — `setAttribute('onerror', ...)` 는 어떤 새니타이저든 제거하므로, 파이프라인을 안전하게 만드는 순간 그 동작이 사라집니다. 삽입된 노드에 `addEventListener` 를 쓰세요.

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
// src/store.ts: export const [items, setItems] = createSignal<string[]>([]);
import { items, setItems } from './store';

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
          setItems([...items(), p.text]);  // 불변 시그널 쓰기, render() 불필요
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

// 파일 저장 — 실패 시 throw
await appStorage.save('data.json', JSON.stringify({ key: 'value' }));

// 파일 저장 — throw 대신 실패를 보고하고 false 로 resolve
const saved = await appStorage.trySave('data.json', JSON.stringify({ key: 'value' }));

// JSON으로 읽기
const data = await appStorage.readJson<{ key: string }>('data.json');

// 텍스트로 읽기
const text = await appStorage.read('data.json');

// 바이너리 읽기 (returns { data, mimeType, encoding: 'base64' | 'text' })
// 디코딩 전에 `encoding` 을 확인하세요 — base64 페이로드만 atob() 해야 합니다.
// 분기를 대신 처리해 주는 readBlob() 사용을 권장합니다.
const binary = await appStorage.readBinary('image.png');

// 파일 목록 (returns [{ path, isDirectory, uri, mimeType }])
// 얕은 목록 — 직계 자식만 반환합니다. 하위 디렉터리는 직접 재귀 순회해야 합니다.
// size / modifiedAt 은 포함되지 않습니다. 필요하면 REST API(`GET /api/storage/{dir}/?list=true`)를 사용하세요.
const files = await appStorage.list();

// 파일 삭제
await appStorage.remove('data.json');
```

### 저장 실패를 삼키지 마세요

자동 저장을 `try { await appStorage.save(...) } catch { /* ignore */ }` 로 감싸면 데이터
손실이 침묵으로 바뀝니다. 앱은 계속 "저장됨"을 표시하고, 사용자는 계속 입력하지만, 아무것도
디스크에 기록되지 않습니다. 대신 `trySave()` 를 쓰세요 — 실패를 로그로 남기고 토스트로
알리며(같은 경로에 대해 5초에 한 번까지만 — 실패하는 자동 저장이 토스트를 도배하지 않도록),
`false` 로 resolve 하므로 호출자가 성공 UI를 *보류*할 수 있습니다:

```typescript
// 나쁨 — 쓰기가 실패해도 "저장됨" 칩이 거짓말을 합니다.
try { await appStorage.save('draft.json', json); } catch { /* ignore */ }
setDirty(false);

// 좋음 — 쓰기가 성사되지 않으면 dirty 를 유지합니다.
if (await appStorage.trySave('draft.json', json, { label: '초안' })) {
  setDirty(false);
}
```

`label` 은 토스트에 표시될 데이터 이름입니다(`Couldn't save 초안: …`). `onError` 를 넘기면
토스트 대신 앱 고유의 표시 수단(예: 인라인 상태 줄)을 쓸 수 있습니다. 어느 쪽이든 실패는
항상 로그로 남으므로 `onError` 를 쓴다고 콘솔 추적을 잃지 않습니다:

```typescript
await appStorage.trySave('draft.json', json, {
  onError: (message) => setSaveStateText(`저장되지 않음 — ${message}`),
});
```

`createPersistedSignal()` 은 쓰기를 `trySave` 로 처리하며 동일한 `label` / `onError` 옵션을
받습니다. 따라서 더 이상 저장되지 않는 시그널은 그 사실을 알립니다.

호출자가 throw 를 실제로 처리하는 곳에는 `save()` 를 그대로 두세요 — 예컨대 에이전트가
호출하는 커맨드 핸들러로 전파해 `AppCommandError` 로 처리하는 경우입니다.

### 에러 처리 헬퍼

`@bundled/yaar` 는 앱들이 자꾸 다시 만드는 작은 헬퍼들을 제공합니다. 인라인 구현보다 이쪽을 쓰세요:

```typescript
import { errMsg, showToast, withLoading, wait, AppCommandError } from '@bundled/yaar';

errMsg(e);                       // e instanceof Error ? e.message : String(e) 대신
showToast('삭제됨', 'success');  // 'info' | 'success' | 'error', 자동 사라짐
await wait(200);                 // new Promise(r => setTimeout(r, 200)) 대신

// loading 을 true 로 두고 fn 실행, throw 는 onError 로, 끝나면 항상 loading 해제.
await withLoading(setLoading, () => fetchIssues(), (msg) => showToast(msg, 'error'));

// 커맨드 핸들러에서 throw 하면 에이전트에 실패가 전달됩니다.
throw new AppCommandError('열린 문서가 없습니다');
```

`debounce` / `throttle` 은 `@bundled/lodash` 에서 가져오세요 — 직접 만들지 마세요.

### 다이얼로그 헬퍼

네이티브 `alert()` / `confirm()` / `prompt()` 는 절대 쓰지 마세요 — 디자인이 이질적이고,
페이지 전체를 블로킹하며, 브라우저를 조작 중인 에이전트까지 멈춥니다. `@bundled/yaar` 가
내장 `y-modal` 클래스로 스타일된 프로미스 기반 대체를 제공합니다 (Escape 취소, Enter 확인,
배경 클릭으로 닫힘):

```typescript
import { showAlert, showConfirm, showPrompt } from '@bundled/yaar';

await showAlert('내보내기 완료.', { title: '내보내기' });

if (await showConfirm(`"${name}" 을(를) 삭제할까요?`, { danger: true, okLabel: '삭제' })) {
  await remove(name);
}

const title = await showPrompt('새 문서 이름:', { initial: '제목 없음' });
if (title !== null) create(title);
```

이보다 복잡한 커스텀 모달은 같은 클래스를 직접 조합하세요: `y-overlay` >
`y-modal` > `y-modal-title` / `y-modal-msg` / `y-modal-actions`.

### 에이전트에서 (MCP 도구)

```
invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })
read('yaar://apps/my-app/storage/data.json')
list('yaar://apps/my-app/storage/')
delete('yaar://apps/my-app/storage/data.json')
```
