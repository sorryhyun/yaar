# 앱 개발 가이드

YAAR에서는 AI에게 무엇을 만들지 말하면 AI가 앱을 만듭니다. TypeScript 작성, 컴파일, 프리뷰, 바탕화면 배포까지 모두 devtools 앱을 통해 AI가 처리하며, 완성된 앱은 [공유 마켓플레이스에 게시](#마켓플레이스에-게시하기)해 누구나 설치할 수 있게 만들 수도 있습니다.

> [English version](../guides/app-development.md)

이 문서는 앱 **작성자**의 매뉴얼입니다. 나머지는 이웃 문서들이 소유하며 여기서 다시 적지 않습니다:
[`apps/CLAUDE.md`](../../apps/CLAUDE.md)(디자인 토큰, Solid 주의사항, 앱 안팎의 링크),
[`docs/reference/uri_reference.md`](../reference/uri_reference.md)(모든 `yaar://` 도어와 verb),
[`docs/reference/app_protocol_reference.md`](../reference/app_protocol_reference.md)(와이어 형태,
postMessage 프레임, 서버 내부). 빌드/검증 명령은 `app-dev` 스킬에 있습니다.

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

사용자는 코드를 직접 작성할 필요가 없습니다. AI가 devtools 앱을 통해 TypeScript를 작성하고, Bun으로 컴파일하고, 결과를 프리뷰한 뒤 앱으로 배포합니다. 빌드된 앱은 모든 라이브러리, CSS, 코드가 하나의 자체 완결형 HTML 파일로 인라인되므로, 별도 의존성 없이 어떤 브라우저에서든 독립적으로 실행할 수 있습니다.

모든 단계는 devtools의 프로토콜 명령이며, `app_command` / `app_query`로 구동됩니다:

| 단계 | 하는 일 |
|---|---|
| **작성** | 소스 파일 생성 — `src/main.ts`와 앱에 필요한 나머지 파일들 |
| **컴파일** | `src/main.ts`를 진입점으로 Bun이 하나의 자체 완결형 HTML로 번들링하고, 소스 AST에서 `dist/protocol.json`을 추출 |
| **프리뷰** | 컴파일 결과를 iframe 윈도우로 엶 |
| **배포** | 빌드 결과를 `apps/{appId}/`로 복사하고 `app.json` 작성 — 바탕화면에 아이콘이 즉시 등장 |

배포는 결과가 따라붙는 단계이므로 알아둘 것이 있습니다:

- **파괴적입니다** — 소스를 덮어쓰고 더는 존재하지 않는 파일을 삭제하므로, 먼저 스냅샷을 찍습니다([앱별 버전 이력](#앱별-버전-이력)).
- 이전 빌드를 실행 중이던 윈도우를 닫고, 앱 에이전트의 캐시된 프로필을 버려 다음 턴이 새 `protocol.json`으로 빌드되게 합니다. 둘 다 그대로 두면 방금 교체한 코드를 계속 서빙하게 됩니다. 배포를 수행한 윈도우 자신은 예외이므로 앱이 스스로를 배포할 수 있고, 닫힌 핸들은 `closedWindows`로 돌아옵니다.
- 배포가 따로 써야 할 문서 파일은 없습니다. `read('yaar://apps/{appId}')`는 호출 시점에 유효 매니페스트를 조립하고 `describe`는 매뉴얼을 조립합니다. 직접 작성한 `agent/prompt.md` / `agent/hint.md` / `agent/SKILL.md`는 앱 디렉터리에 있는 그대로 사용되며 clone과 deploy가 함께 운반합니다.

사용 가능한 명령의 전체 목록은 `describe('yaar://apps/devtools')`로 확인하세요 — 매니페스트는 앱 자신의 `protocol.json`에서 생성됩니다.

### 기존 앱 수정 — clone → 편집 → compile → deploy

AI가 기존 앱의 소스를 devtools 워크스페이스로 복제하고, 편집 후 다시 컴파일하여 동일한 appId로 재배포합니다.

### 독립 실행 프리뷰 — 바탕화면 없이 앱 하나만 구동하기

*하나의 앱*만 검증할 때 — 특히 CDP를 통해서, 테스트에서, 또는 다른 에이전트에서 — 바탕화면 전체는 잘못된 도구입니다. 윈도우 관리와 씨름해야 하고, 크로스 오리진 앱 iframe 안으로 들어갈 수 없으며, 앱 자체의 자동화 훅은 두 단계 프레임 아래에 있습니다. 대신 앱을 최상위 페이지로 여세요:

```
http://localhost:8000/api/dev/preview/{appId}
```

이 경로는 배포된 앱의 `dist/index.html`을 **실제 iframe 토큰이 주입된 채로** 제공하므로, 토큰으로 게이트된 SDK 호출(`appStorage`, `appDb`, `/api/ml-weights`, verb SDK)이 윈도우 안에서와 완전히 동일하게 동작합니다. 신원은 앱 자신의 것입니다 — 권한과 `bundles`는 요청이 아니라 앱의 `app.json`에서만 나오므로, 프리뷰가 배포된 앱이 거부당할 무언가를 통과시킬 수는 없습니다.

```js
// CDP로 말하는 모든 것: Playwright, Puppeteer, claude-in-chrome, …
navigate('http://localhost:8000/api/dev/preview/ocr');
javascript_tool("await window.__ocr.readSample()"); // 앱 자체의 자동화 훅
```

참고 사항:

- **호스트 전용.** 이 경로는 앱의 토큰을 내주므로 — `POST /api/iframe-token`과 마찬가지로 — 앱 iframe에는 거부됩니다. `REMOTE=1`에서는 호출자가 이미 원격 토큰을 갖고 있어야 합니다.
- **`127.0.0.1`이 아니라 `localhost`.** 앱 오리진 격리가 켜져 있으면 `127.0.0.1`은 앱 오리진 *자체*이므로 토큰 없는 요청이 이를 실어 오면 설계상 거부됩니다. 최상위 내비게이션은 자동으로 리다이렉트되지만, 프리뷰 URL을 `fetch`하는 경우는 해당되지 않습니다.
- 세션 범위 verb(윈도우, 알림)는 연결된, 실행 중인 바탕화면의 세션에 바인딩됩니다. 바탕화면이 떠 있지 않아도 앱은 자신의 스토리지, DB, 게이트된 HTTP 도어는 그대로 사용할 수 있습니다.
- 앱은 **배포되어** 컴파일된 상태여야 합니다. devtools 워크스페이스의 아직 컴파일되지 않은 프로젝트라면 먼저 컴파일하세요 — `POST /api/dev/compile`이 `previewUrl`을 반환합니다.

두 표면을 처음부터 끝까지 구동하는 방법: [`docs/guides/headless_driving.md`](../guides/headless_driving.md).

## URI 동사

모든 작업은 `yaar://` URI에 5개의 범용 동사(`read`, `list`, `invoke`, `delete`, `describe`)를 적용해 수행합니다. 도어별 전체 표는 [`docs/reference/uri_reference.md`](../reference/uri_reference.md)에 있으며, 앱 작성자에게 필요한 것만 아래에 정리합니다.

> **참고:** `yaar://session/*`는 **세션 에이전트 전용**입니다 — 세션 프린시펄만의 프라이빗 네임스페이스이며, `app.json` 권한과 무관하게 앱이 `POST /api/verb`로 접근할 수 없습니다(앱은 이를 스스로에게 부여할 수 없습니다). 여기에는 `yaar://session/browser`(세션 에이전트가 사용자의 *실제* 브라우저로 통하는 문)도 포함됩니다. 브라우징이 필요한 앱은 `@bundled/yaar-web` → 헤드리스 샌드박스를 대신 사용해야 합니다.

### Devtools 앱

앱 개발(작성, 편집, 컴파일, 타입 검사, 배포, 복제)은 **devtools 앱**을 통해 App Protocol 명령으로 처리됩니다. devtools 앱은 iframe 윈도우에서 실행되며, 이러한 작업을 프로토콜 명령으로 제공합니다. AI가 devtools 윈도우를 열고 `app_command`와 `app_query`로 상호작용합니다.

### 앱 — `yaar://apps/`

이 도어에 대해 알아야 할 네 가지이며, 자세한 내용은 [URI 참조 → Apps](../reference/uri_reference.md#apps--yaarappsappid)에 있습니다:

- **`describe`는 매뉴얼이고 `read`는 현재 값입니다.** `describe('yaar://apps/{appId}')`는 "이 앱이 무엇이고 어떻게 조작하는가"에 답합니다: 신원, 앱이 함께 배포한 `agent/SKILL.md`, 권한, 그리고 프로토콜의 **목차** — state 키와 command의 *이름*, 그리고 각각을 온전히 서빙하는 URI. `read`는 "여기 무엇이 설치되어 있는가"에 답하며 유효 매니페스트를 반환합니다.
- **프로토콜은 자기 자신의 리소스입니다.** `yaar://apps/{appId}/protocol` — `list`는 색인, `read`는 매니페스트 전체, `read …/protocol/commands/{name}`은 명령 하나. `describe`에 인라인되지 않는 이유는 신원이 고정된 약 10 KB인 반면 명령 52개짜리 매니페스트는 41.8 KB이고 계속 자라기 때문입니다. CLI의 인라인 결과 임계값을 넘으면 합쳐진 답은 비싸지는 게 아니라 아예 *사라집니다*.
- **`read`의 capability 필드는 승인 이후 값입니다.** `subagents`와 `streams`는 `app.json`이 선언한 것과 사용자가 설치 시 승인한 것(`config/app-grants.json`)의 교집합입니다. `yaar-dev`를 쥔 앱은 자기 매니페스트를 다시 쓸 수 있으므로, 선언은 요청이고 승인이 천장입니다.
- **`yaar://apps/{appId}/state/…`와 `/commands/…`는 어떤 동사로도 주소가 되지 않습니다.** 프로토콜 state는 실행 중인 윈도우의 것입니다 — `yaar://windows/{windowId}/state/{key}`. `storage/`, `db/`, `agents/` 하위 경로는 다섯 동사를 모두 유지합니다.

`yaar://apps/{appId}`에 대한 `invoke`는 `set_badge`(`{ count }`, `0`이면 해제), `install`, `clone`, `publish`, `publish_prepare`, `publish_confirm`, `publish_cancel`을 받습니다 — [마켓플레이스에 게시하기](#마켓플레이스에-게시하기) 참조. `delete`는 앱을 삭제합니다.

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
| `read` | `yaar://skills/{topic}` | 참조 문서 로드 (`components`, `config`, `marketplace`, `remote`) |

## 마켓플레이스에 게시하기

배포(deploy)는 앱을 *당신의* 바탕화면에 올립니다. 게시(publish)는 앱을 공유 YAAR 마켓플레이스로 올려 누구나 설치할 수 있게 합니다. 전체 라이프사이클은 **작성 → 컴파일 → 배포 → 게시**이며, 설치는 다른 사람의 머신에서 이를 거울처럼 반복하는 과정입니다. Market Apps 앱(🛒, `apps/market-apps`)이 양방향 모두의 관문이고, AI는 `yaar://apps/{appId}` verb로 모든 단계를 직접 수행할 수도 있습니다.

**게시자 신원은 Google ID 토큰입니다** — Google이 서명한 JWT로 당신의 이메일을 증명하며, 마켓플레이스는 이를 Google의 공개 키로 검증합니다. API 키도, 공유 비밀도, 기기 등록도 없습니다. Market Apps 윈도우에서 로그인하면 YAAR가 시스템 브라우저로 Google 동의 화면을 열고(`/api/auth/google/callback`으로의 루프백 리다이렉트를 통한 PKCE), `openid email` 스코프만 요청합니다. **리프레시 토큰**이 로컬(설정 디렉터리)에 저장되는 유일한 것이며, ID 토큰은 1시간짜리로 필요할 때마다 생성되어 메모리에만 캐시됩니다. 토큰 교환은 마켓플레이스(`MARKET_URL/api/auth/exchange`)를 경유합니다 — Google의 데스크톱 클라이언트 토큰 엔드포인트가 요구하는 `client_secret`을 사용자 머신에 설치되는 오픈소스 앱은 안전하게 보관할 곳이 없기 때문입니다. YAAR는 할 수 있는 절반(동의 화면 열기, PKCE verifier 보관, 코드 수신)을 처리하고 마켓플레이스가 시크릿을 더하며, 돌아오는 것은 토큰뿐입니다. 인증 라우트는 호스트/번들 앱 전용입니다(`http/routes/auth.ts`).

**게시되는 것**은 앱 디렉터리의 tar.gz이며 각 엔트리는 `{appId}/`로 시작합니다 — `GET /api/apps/{id}/download`가 만드는 것과 같은 모양이라 왕복이 대칭적입니다. `dist/`(마켓플레이스는 *소스*를 배포하고 설치 시 YAAR가 컴파일합니다)와 macOS 잔재물(`.DS_Store`, `._*`)은 제외됩니다. 시크릿은 문제가 되지 않습니다 — 자격 증명은 `config/{appId}.json`에 별도로 저장되며 `apps/{appId}/` 안에는 들어가지 않습니다([자격 증명 관리](#자격-증명-관리) 참조).

마켓플레이스는 앱을 자신의 git 저장소에 커밋하므로 게시는 즉시가 아니라 큐에 들어갑니다 — "약 1분 후 반영됩니다". 앱 id는 `^[a-z][a-z0-9-]*$`와 일치해야 하고, 그 외에 두 이름이 예약되어 있습니다: `self`(모든 앱이 자기 네임스페이스를 가리킬 때 쓰는 대명사)와 `preview--`로 시작하는 모든 이름(devtools 프리뷰의 신원). `packages/server/src/features/apps/roots.ts`의 `appIdRefusal`이 유일한 정의이며, id를 주장하는 모든 지점(배포, 설치, 게시)에서 확인됩니다.

**게시 전에 `app.json`의 `"version"`을 올리세요.** 마켓플레이스는 더 높지 않은 버전을 거부하고, YAAR도 패키징 *전에* 로컬에서 같은 것을 확인하므로 업로드를 기다리지 않고 바로 알 수 있습니다. 이 확인은 최선 노력이며 fail-open입니다 — 카탈로그에 접근할 수 없거나 한 번도 게시된 적이 없으면 게시가 허용되고 마켓플레이스가 최종 방어선입니다.

```
// 단일 단계 — 현재 디스크 상태를 패키징해 한 번에 업로드.
invoke('yaar://apps/{appId}', { action: 'publish' })
// → { published: true, appId, commit, files, message }

// 2단계 — 정확한 바이트를 고정해 사용자에게 보여준 뒤 *그 바이트*를 업로드.
invoke('yaar://apps/{appId}', { action: 'publish_prepare' })
// → { prepared: true, publicationId, appId, version, byteLength, artifactSha256, ... }
invoke('yaar://apps/{appId}', { action: 'publish_confirm', publicationId })
invoke('yaar://apps/{appId}', { action: 'publish_cancel', publicationId })
```

단일 단계 업로드는 일시적인 업스트림 실패(429/5xx, 연결 끊김)에 대해 최대 3회 재시도합니다 — 전체 업로드가 완료되기 전까지 아무것도 커밋되지 않으므로 안전합니다. `prepare`와 `confirm` 사이에 YAAR는 **소스 드리프트**를 감시합니다: `src/`나 `app.json`이 바뀌었다면 `confirm`은 `{ published: false, status: 'drift_detected', ... }`로 거부하고 바뀐 파일을 알려줍니다. 다시 `prepare`하거나 `acknowledgeDrift: true`로 고정된 바이트를 그대로 내보내세요. 그 외의 치명적이지 않은 상태(`expired`, `not_found`)도 같은 구조화된 형태로 돌아옵니다. 준비된 게시는 15분 후 정리됩니다. 드리프트는 재압축이 아니라 `src/`와 `app.json`의 콘텐츠 해시로 감지합니다 — gzip 스트림은 mtime을 새기므로 아무것도 바뀌지 않아도 바이트 단위로 동일하지 않기 때문입니다.

### 설치와 삭제

```
invoke('yaar://http', { url: '<MARKET_URL>/api/apps' })   // 카탈로그 탐색
invoke('yaar://apps/{appId}', { action: 'install' })      // 다운로드 + 설치
delete('yaar://apps/{appId}')                             // 삭제
list('yaar://apps')                                       // 설치된 앱 목록
```

`<MARKET_URL>`은 마켓플레이스 오리진입니다(서버 환경 변수 `MARKET_URL`). `install`은 tarball을 다운로드하고 압축을 풀고 — 마켓플레이스가 소스를 배포하므로 — 로컬에서 앱을 컴파일합니다. 새로 설치되는 앱은 git-ignored된 user-apps 루트에 놓여 추적 중인 번들 트리를 오염시키지 않습니다. 이미 설치된 앱을 다시 설치하면 그 자리에서 업데이트됩니다. 번들된 `"kind": "system"` 앱은 마켓플레이스에서 교체할 수 없습니다. 앱이 `permissions`를 선언하면 설치가 완료되기 전에 사용자에게 승인을 요청합니다.

AI는 이 모든 것을 `read('yaar://skills/marketplace')`를 통해 접근합니다. 이 토픽은 `MARKET_URL`이 치환된 실제 마켓플레이스 API를 문서화합니다.

## 번들 라이브러리

`@bundled/*` import로 사용 가능 — npm install 불필요. 신뢰할 수 있는 목록은 `packages/compiler/src/bundled/registry.ts`의 `BUNDLED_LIBRARIES`이며, `GET /api/dev/bundled-libraries`에서도 제공됩니다.

| 라이브러리 | import 경로 | 용도 |
|-----------|------------|------|
| solid-js | `@bundled/solid-js` | 반응형 UI (createSignal, createEffect, Show, For 등) |
| solid-js/html | `@bundled/solid-js/html` | `html` 태그드 템플릿 (JSX 미사용) |
| solid-js/web | `@bundled/solid-js/web` | `render`, DOM 헬퍼 |
| solid-js/store | `@bundled/solid-js/store` | 중첩 반응형 스토어: `createStore` 와 함께 `produce` (깊은 업데이트를 위한 가변 draft), `reconcile` (새 데이터를 병합하되 행 identity 는 유지), `unwrap` (JSON/스토리지용 원본 객체) |
| uuid | `@bundled/uuid` | ID 생성 |
| lodash | `@bundled/lodash` | 유틸리티 (debounce, cloneDeep, groupBy 등) |
| date-fns | `@bundled/date-fns` | 날짜 처리 |
| anime.js | `@bundled/anime` | 애니메이션 |
| Three.js | `@bundled/three` | 3D 그래픽 |
| Three.js 애드온 | `@bundled/three/addons` | 선별된 `examples/jsm`: `GLTFLoader`/`GLTFExporter` (glTF + GLB — 직접 리더를 만들지 마세요), `OBJLoader`/`MTLLoader`/`STLLoader`/`SVGLoader`, `FontLoader` + `TextGeometry`, `OrbitControls`/`MapControls`/`PointerLockControls`/`TransformControls`, `BufferGeometryUtils`/`SkeletonUtils`. Draco/KTX2/meshopt 로더는 의도적으로 제외 — 런타임에 디코더를 fetch 하는데 단일 파일 앱에는 그것을 서빙할 곳이 없습니다 |
| cannon-es | `@bundled/cannon-es` | 3D 물리 엔진 |
| xlsx | `@bundled/xlsx` | 스프레드시트 파싱/생성 |
| Chart.js | `@bundled/chart.js` | 차트/그래프 |
| D3 | `@bundled/d3` | 데이터 시각화 |
| Matter.js | `@bundled/matter-js` | 2D 물리 엔진 |
| Tone.js | `@bundled/tone` | 오디오/음악 |
| mediabunny | `@bundled/mediabunny` | 미디어 파일 읽기/쓰기/변환 (mp4, webm, mp3, wav). 실시간에 묶이지 않는 프레임 단위 인코딩 — 부하가 걸리면 프레임을 흘리고 기존 파일은 읽지도 못하는 `MediaRecorder` + `canvas.captureStream()` 대신 사용하세요. WebCodecs 가 필요하므로 인코딩 전에 `getFirstEncodableVideoCodec([...])` 로 확인하세요. 약 0.66 MB |
| PixiJS | `@bundled/pixi.js` | 2D WebGL 렌더링 |
| marked | `@bundled/marked` | 마크다운 → HTML |
| Mermaid | `@bundled/mermaid` | 텍스트 → 다이어그램 (flowchart, sequence, class, state, ER, gantt, mindmap 등). `renderMermaid(src)` 를 쓰면 디자인 토큰에 맞춰 테마가 적용된 새니타이즈된 SVG 를 반환합니다 — 다시 새니타이즈하지 마세요. 약 3.3 MB 이므로 다이어그램을 그리는 앱에서만 임포트하세요 |
| Prism | `@bundled/prismjs` | 구문 강조 |
| DOMPurify | `@bundled/dompurify` | HTML 새니타이즈 — 직접 호출하지 말고 `@bundled/yaar`의 `sanitizeHtml`을 통해 사용하세요 |
| Zod (Mini) | `@bundled/zod` | 신뢰 경계에서 외부/영속 JSON 검증 (함수형 Mini API) |
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
| Dev Tools | `@bundled/yaar-dev` | `compile()`, `typecheck()`, `deploy()`, `bundledLibraries()`, 그리고 앱별 버전 이력: `gitHistory()`, `gitDiff()`, `gitRestore()`, `gitCheckpoint()` | `"yaar-dev"` |
| Browser | `@bundled/yaar-web` | `open()`, `click()`, `type()`, `extract()` 등 | `"yaar-web"` |
| ML 런타임 | `@bundled/yaar-ml` | 브라우저 내 모델 추론(WebGPU/wasm): `session()`, `run()`, `capabilities()`, `fetchWeights()` | `"yaar-ml"` |

ML 런타임의 기능, 메모리 제한, "무엇이 들어맞는지"에 대한 가이드는 [`docs/guides/yaar_ml_runtime.md`](./yaar_ml_runtime.md)를 참조하세요.

```json
{ "bundles": ["yaar-dev"], "permissions": ["yaar://storage/", "yaar://apps/"] }
```

기본 `@bundled/yaar` SDK(verb, storage, app protocol, 유틸리티)는 모든 앱에서 선언 없이 사용할 수 있습니다.

### 앱별 버전 이력

모든 배포 전에 스냅샷이 먼저 찍힙니다. 각 앱은 **워크트리가 앱 디렉터리 자체인** 자신만의 섀도 git 저장소를 가지며, 이것이 바로 "앱 경계"를 우리가 걸러내는 규칙이 아니라 git이 강제하는 경계로 만들어줍니다. 저장소 메타데이터는 git-ignored된 `storage/app-git/<appId>.git`에 있으며 앱 내부에는 절대 없습니다 — 사용자 자신의 저장소는 중첩된 `.git`을 보지 않고, 그 이력도 에이전트 커밋으로 오염되지 않습니다. `dist/`와 `credentials.json`은 제외됩니다.

- `gitDiff`는 두 가지 기준을 받습니다. `against: "snapshot"`(기본값)은 앱의 파일을 자신의 이력 속 커밋과 비교합니다 — *마지막 배포 이후 무엇이 바뀌었는지* — 모든 앱에서 동작합니다. `against: "repo"`는 사용자 자신의 git 저장소와 비교하며, 읽기 전용이고 번들 앱 전용입니다(`user-apps/`는 git-ignored이므로).
- `gitRestore(appId, ref)`는 앱을 롤백하고 다시 빌드합니다. 먼저 스냅샷을 남기고 롤백을 `HEAD`를 옮기는 대신 새 커밋으로 덧붙이므로, 이력은 append-only이며 되돌리기 자체도 되돌릴 수 있습니다.
- 다른 앱의 디렉터리에 쓰는 작업(`deploy`, `gitRestore`, `gitCheckpoint`)은 번들 앱으로 제한됩니다 — `"bundles": ["yaar-dev"]`를 선언한 마켓플레이스 앱은 자기 자신만 수정할 수 있습니다.

## TypeScript 주의 사항

`apps/tsconfig.json`이 모든 앱을 하나의 프로그램으로 컴파일하므로, 최상위 `import`나 `export`가 하나도 없는 `src/main.ts`는 스크립트로 인식되어 최상위 이름이 다른 앱과 충돌합니다. `@bundled/*`에서 import하는 앱 — 즉 `defineApp`을 호출하는 모든 앱 — 은 이미 모듈입니다. 아무것도 import하지 않는 파일에만 `export {};`를 넣으세요.

## UI 크롬 & 헤드리스 프리미티브

컴파일러는 컴파일된 모든 앱에 `y-*` 유틸리티/크롬 레이어를 주입합니다 — 색상, 여백, 레이아웃, 버튼, 그리고 **문서형 앱 크롬 패밀리**(앱 바, 제목 필드, 서식 툴바, 상태 바)까지 포함합니다. CSS를 직접 작성하는 대신 이를 재사용하세요: 이 CSS는 어차피 모든 앱에 실려 가므로 추가 바이트 비용이 없고, 테마에 맞춰 자동으로 색이 바뀌며, 앱 에이전트에게도 자동으로 안내됩니다. **색상은 절대 하드코딩하지 말고** 항상 `var(--yaar-*)`를 사용하세요. 전체 클래스 목록은 [`apps/CLAUDE.md`](../../apps/CLAUDE.md#design-tokens)에 있고, 크롬과 콘텐츠를 구분하는 규칙과 예외 목록은 [`docs/architecture/design_system.md`](../architecture/design_system.md)를 참조하세요.

### 문서형 앱 스켈레톤

워드, 슬라이드, 파일류 앱은 같은 표면을 공유합니다: 신원 바, 인라인 편집 가능한 제목, 서식 툴바, 저장 상태 칩. 아래 스켈레톤을 붙여넣고 브랜드와 버튼만 채우세요 — 스타일은 클래스가 전부 처리합니다:

```typescript
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';

render(() => html`
  <div class="y-app">
    <!-- 신원 바: 브랜드 + 제목 필드 + 주요 액션 -->
    <div class="y-appbar">
      <div class="y-brand">
        <span class="y-brand-badge">W</span>
        <span class="y-brand-name">My App</span>
      </div>
      <div class="y-doc-field">
        <input class="y-doc-input" type="text" placeholder="Untitled" />
      </div>
      <div class="y-appbar-actions">
        <button class="y-tbtn y-tbtn-text y-tbtn-primary" title="Save (Ctrl+S)">Save</button>
      </div>
    </div>

    <!-- 서식 툴바: y-tsep으로 구분된 그룹(y-tgroup) -->
    <div class="y-editbar">
      <div class="y-tgroup">
        <select class="y-tselect" title="Style">
          <option>Paragraph</option>
        </select>
      </div>
      <div class="y-tsep"></div>
      <div class="y-tgroup">
        <button class="y-tbtn" title="Bold">B</button>
        <button class="y-tbtn y-tbtn-active" title="Italic">I</button>
      </div>
    </div>

    <!-- 콘텐츠 영역 -->
    <div class="y-scroll" style="position:absolute; inset:0; top:auto"></div>

    <!-- 상태 바: 왼쪽에 통계, 오른쪽에 저장 상태 칩 -->
    <div class="y-statusbar">
      <span>0 words</span>
      <span class="y-chip y-chip-muted">Saved</span>
    </div>
  </div>
`, document.getElementById('app')!);
```

크롬 클래스: `y-appbar` / `y-appbar-actions`, `y-brand` / `-badge` / `-name`, `y-doc-field` / `y-doc-icon` / `y-doc-input`, `y-editbar`, `y-tgroup` / `y-tsep`, `y-tbtn` (`-text` / `-primary` / `-active`), `y-tlabel`, `y-tselect`, `y-statusbar`, `y-chip` (`-warning` / `-muted`). 접었다 펴는 사이드바/오버레이는 `y-nav-*` 패밀리(`y-nav-root`, `y-nav-panel`, `y-nav-hover-zone`, `y-nav-pin`, `y-nav-resizer` 등)를 사용합니다. 이 스켈레톤은 의도적으로 **컴포넌트가 아니라 스니펫**입니다 — 복사해 오는 크롬은 짧고, 그 다음부터는 당신이 편집하면 됩니다.

### 헤드리스 동작 프리미티브

앱들이 계속 다시 구현하던 상태 머신들이 `@bundled/yaar`에 **헤드리스** 프리미티브로 들어 있습니다 — 상태와 핸들러를 반환하고, 마크업은 앱이 소유합니다. 모두 트리 셰이킹되므로 import하지 않는 앱은 아무 비용도 치르지 않습니다.

| 프리미티브 | 담당하는 것 |
|---|---|
| `createCollapsiblePanel({ pinKey, closeDelayMs })` | 호버로 펼쳐지고 고정할 수 있는 사이드바. `expanded()`, `pinned()`, `open()`, `scheduleClose()`, `close()`, `cancelClose()`, `togglePin()`, `setPin(v)`, `setResizing(active)`. `pinKey`를 주면 고정 상태가 영속됩니다. 패널이 소유하지 않은 사정은 두 술어로 다룹니다 — `canOpen`은 `open()` 시점에(다른 곳에서 시작된 드래그가 레일 위를 지나갈 때 `false`), `holdOpen`은 접힘이 *실제로 실행될 때*(패널 안 입력 필드가 포커스를 쥔 동안 `true`, 포커스가 빠지면 `scheduleClose()` 재호출) |
| `createAutosave(save, { debounceMs })` | dirty / 디바운스 저장 / 저장 상태 라이프사이클. `save`는 성공하면 `true`, `false`면 문서를 dirty로 유지합니다. `editSeq` 가드 덕분에 최신 편집보다 먼저 시작된 저장이 dirty 플래그를 지우지 않습니다. 입력 시 `markDirty(value)`, Ctrl+S 시 `flush(true)`, `statusLabel()`은 `"Saving…"` \| `"Saved 14:22"` \| `"Not saved"` — `y-chip`과 짝지어 쓰세요 |
| `createPersistedSignal(path, fallback, opts?)` | `trySave`를 통해 `appStorage`에 자동 동기화되는 Solid 시그널. 저장 상태 표시가 필요 없을 때 더 가벼운 선택 |
| `createStaleGuard()` | 늦게 도착한 응답이 더 새로운 응답을 덮어쓰지 않게 하는 세대 카운터 |
| `createKeyState(opts?)` | 게임 루프용 키 홀드 추적 — 선언적 `keybindings`의 연속 입력 쪽 짝 |

```typescript
import { createStaleGuard, createKeyState } from '@bundled/yaar';

const guard = createStaleGuard();
async function loadPost(id: string) {
  const fresh = guard.begin();   // 이미 진행 중인 것을 무효화
  const post = await fetchPost(id);
  if (!fresh()) return;          // 더 새로운 로드가 시작됨 — 이 응답은 버림
  setState('post', post);
}
// guard.latest()는 현재 세대에 합류만 하고 무효화하지 않으며,
// guard.invalidate()는 fetch 없이 세대를 올려 진행 중인 것을 전부 버립니다.

const keys = createKeyState({ preventDefault: ['arrowup', 'arrowdown', ' '] });
function frame(dt: number) {
  if (keys.has('w') || keys.has('arrowup')) player.y -= speed * dt;   // 레이아웃이 찍는 키
  if (keys.has('KeyD')) player.x += speed * dt;                       // 물리적 키
}
```

`createKeyState`는 까다로운 부분을 기본으로 처리합니다: OS 자동 반복 무시, 윈도우 blur와 탭 숨김 시 홀드 상태 초기화(`w`를 누른 채 alt-tab했다고 캐릭터가 영원히 달려서는 안 됩니다), 해제는 `e.code` 기준이라 홀드 중 수정자가 `e.key`를 바꿔도(macOS에서 Alt+W는 `∑`) 키가 끼지 않으며, 편집 가능한 엘리먼트에서 발생한 입력은 무시합니다(`ignoreEditable: false`로 해제). `onClose`에서 `keys.dispose()`. 기준: 개별 동작(일시정지, 회전)은 선언적 `keybindings`, 연속 이동은 `requestAnimationFrame` 루프 안의 `createKeyState`.

`createPersistedSignal`에서 각각 버그를 한 번씩 낸 세 가지:

- **`revive`는 값이 시그널에 닿기 전에 실행됩니다** — 저장된 너비를 클램프하거나, 이름이 바뀐 키를 마이그레이션하거나, 예전 버전이 쓴 JSON을 `z.safeParse`할 자리입니다. 저장된 것이 없을 때 **fallback에도** 실행되므로 전역 함수여야 하며, throw하면 fallback이 쓰이고 실패는 로그로 남습니다.
- **한 번만 일어나는 부수 효과 앞에서는 세 번째 반환값을 await하세요.** 시그널은 fallback으로 시작해 저장된 값이 도착하면 갱신됩니다 — *렌더링*에만 쓰인다면 보이지 않지만, **한 번만** 실행되는 결정에는 보입니다. `ready`는 로드가 끝난 시점에 시그널이 담고 있는 값으로 resolve되며, reject되는 일은 없고, 로드보다 먼저 도착한 set이 이깁니다.

  ```typescript
  const [conceptMode, setConceptMode, conceptModeReady] = createPersistedSignal(
    'preferences/concept-mode.json', false,
  );
  onMount(async () => {
    await conceptModeReady; // 없으면 첫 fetch는 항상 `false`를 봅니다
    void loadFeed(conceptMode());
  });
  ```

- **텍스트 입력에 연결한다면 `debounceMs`를 넘기세요.** 기본값은 매 set마다 쓰기이고, 주로 담는 토글에는 그것이 맞습니다 — set 한 번이 클릭 한 번이니까요. 하지만 `onInput`은 키 입력마다, IME에서는 조합 단계마다 발생하므로 한글 이름 다섯 글자가 쓰기 열두 번, 세션 로그 열두 줄이 됐습니다. `debounceMs: 400`이 이를 한 번의 쓰기로 합치고, 대기 중인 쓰기는 페이지가 숨겨질 때 flush되므로 디바운스 도중에 창을 닫아도 저장됩니다. 시그널 자체는 지연되지 않습니다 — 쓰기만 지연됩니다.

## 런타임 제약 사항

컴파일된 앱은 **브라우저 iframe 샌드박스**에서 실행됩니다. 다음과 같은 하드 제약이 있습니다:

- **Node.js API 없음** — `fs`, `process`, `child_process`, `net` 등을 사용할 수 없습니다. 브라우저 환경입니다.
- **서버 프로세스 없음** — 앱은 포트를 열거나, 서버를 실행하거나, 백그라운드 데몬을 돌릴 수 없습니다.
- **OAuth 플로우 불가** — OAuth code-for-token 교환에는 서버 측 `client_secret`이 필요합니다. iframe 앱에서는 안전하게 수행할 수 없으므로, API 기반 앱 패턴을 사용하세요 (아래 참조).
- **크로스 오리진 HTTP는 프록시 경유** — `@bundled/yaar`의 `httpFetch`를 사용하고 `app.json`에 `yaar://http`를 선언하세요. [HTTP 요청하기](#http-요청하기)를 참조하세요.
- **localStorage/IndexedDB 사용 금지** — `@bundled/yaar`의 `appStorage`를 사용하세요 (서버 측 저장, 세션 간 유지).
- **자체 완결형** — 앱은 외부 서버, localhost 서비스, iframe 외부 인프라에 의존해서는 안 됩니다.

## 신뢰할 수 없는 HTML 렌더링

앱이 직접 작성하지 않은 HTML — 스토리지에서 읽은 마크다운, 스크래핑한 페이지, RSS 피드
본문, GitHub README, `appStorage` 를 거쳐 되돌아온 콘텐츠 — 은 DOM 에 닿기 전에 반드시
**`@bundled/yaar`의 `sanitizeHtml`** 을 통과해야 합니다. 앱은 iframe 안에서 실행되지만, 그 iframe 은 앱
자신의 스토리지, 자격 증명, 에이전트와의 프로토콜 채널을 쥐고 있습니다. 주입된 스크립트는
그 전부를 장악합니다.

모든 리치 콘텐츠 파이프라인은 다음 순서를 따릅니다:

1. 마크다운 또는 원본 콘텐츠를 파싱한다;
2. **완성된 프래그먼트를 새니타이즈한다**;
3. 새니타이즈된 프래그먼트에 앱 고유의 DOM 재작성을 수행한다;
4. 결과를 삽입한다;
5. 인라인 이벤트 속성이 아니라 이벤트 리스너로 동작을 연결한다.

```typescript
import { sanitizeHtml } from '@bundled/yaar';

const clean = sanitizeHtml(marked.parse(source) as string);
const doc = new DOMParser().parseFromString(clean, 'text/html');
rewriteRelativeLinks(doc);       // 이미 안전한 HTML 위에서 도는 앱 로직
el.innerHTML = doc.body.innerHTML;
attachImageFallbacks(el);        // 삽입 후 addEventListener
```

2번과 3번의 순서에는 이유가 있습니다. 먼저 새니타이즈하면 안전하지 않은 원본 속성이 재작성 단계까지 살아남지 못하고, 그 뒤에 재작성하면 기본 정책을 약화시키지 않고도 앱이 안전하다고 아는 URL과 속성을 만들어 넣을 수 있습니다. 순서를 뒤집으면 재작성 코드가 공격자가 통제하는 입력을 받게 됩니다. 5번도 그만큼 중요합니다: DOMPurify는 `onerror`/`onload`/`onclick`을 무조건 제거하므로 `img.setAttribute('onerror', …)`로 만든 폴백은 새니타이저를 도입하는 순간 조용히 멈춥니다 — 대신 삽입된 노드에 실제 `addEventListener('error', handler, { once: true })`를 등록하세요.

파이프라인당 한 곳에서만 새니타이즈하세요. 외부 콘텐츠가 앱 상태로 처음 들어오는 지점이 가장 좋습니다. 그래야 하위의 모든 싱크가 구조적으로 안전해집니다. 정책이 두 겹으로 겹치는 것은 한 겹보다 나쁩니다 — 다음 편집자가 다른 쪽이 막아준다고 믿고 한쪽을 느슨하게 만듭니다.

옵션 없는 `sanitizeHtml(dirty)`가 기본 정책입니다 — DOMPurify 자체 기본값(스크립트, 이벤트 핸들러, `javascript:`/`data:` URL을 이미 제거)에 모든 YAAR 앱이 공유하는 한 가지 수정을 더한 것: `form`과 그 컨트롤은 금지됩니다. 이들은 DOMPurify 기본 `ALLOWED_TAGS`에 있고, 범용 새니타이저에는 맞지만 앱 iframe에는 맞지 않습니다 — YAAR가 렌더링하는 외부 콘텐츠에 폼 전송이 필요한 정당한 이유가 없고, iframe 안의 폼은 프레임을 이동시키거나 앱 크롬을 상대로 피싱할 수 있습니다. 콘텐츠 종류가 정말로 다른 허용 목록을 필요로 할 때만 — 인쇄용 문서는 산문 렌더링에 필요 없는 인라인 `style`이 필요합니다 — 옵션 객체(`allowedTags`, `allowedAttr`, `forbidTags`, `forbidAttr`)를 넘기고 그 이유를 옆에 주석으로 남기세요. 폼 금지는 DOMPurify의 *기본* 허용 목록에 대한 수정이며, `allowedTags`를 넘기는 순간 그 목록이 정책 전체가 되고 뒤에서 아무것도 빼주지 않습니다.

`@bundled/dompurify`를 직접 호출하지 말고, 새니타이저를 직접 만들지도 마세요 — 엘리먼트 차단 목록과 `^on` 속성 제거는 `<svg>`/`<math>` 뮤테이션 XSS, `srcset`, `formaction`, `xlink:href`를 놓칩니다. 추가로 세 가지:

- **상대 URL은 그대로 살아남습니다** — `sanitizeHtml`은 이를 제거하지도, 절대 경로로 바꾸지도 않으므로, 해석이 필요한 앱은 3번 단계에서 *새니타이즈된* 결과를 재작성해야 합니다. **링크** href는 예외입니다: `app.json`에 `"links": { "base": "https://origin.example" }`를 선언하면 링크 가드가 클릭 시 그 사이트를 기준으로 앵커를 해석합니다. 클릭에만 적용되므로 `<img src>`는 여전히 직접 재작성해야 합니다. [`apps/CLAUDE.md`](../../apps/CLAUDE.md#links-out-of-an-app) 참조.
- **`USE_PROFILES`는 `ALLOWED_TAGS`와 교집합을 이루지 않고 덮어씁니다.** 이미 명시적인 `ALLOWED_TAGS`가 있는 설정에 `USE_PROFILES: { html: true }`를 추가하면 그 목록이 DOMPurify의 훨씬 넓은 HTML 프로필로 *교체*됩니다 — 더 엄격해 보이는 정책이 어느 순간 `<form action="//evil">`을 조용히 통과시킵니다.
- **새니타이저는 jsdom이나 실제 브라우저에서 테스트하고, happy-dom은 절대 쓰지 마세요.** DOMPurify는 `isSupported`를 확인해 호스트 DOM이 불완전하면 조용히 no-op이 되므로, happy-dom에서는 `javascript:` href가 그대로 통과하는 동시에 happy-dom 자체 파서가 멀쩡한 `<table>`/`<pre>` 래퍼를 제거합니다 — 한 번의 초록불 실행에서 거짓 통과와 거짓 실패가 동시에 나옵니다. 살아남으면 안 되는 것(`<script>`, `<iframe>`, `<object>`, `<form>`, SVG로 감싼 script, `javascript:` URL, 인라인 `on*=`)**과** 반드시 살아남아야 하는 것(표, 코드 블록, 이미지, 링크)을 **모두** 검증하세요. 전부 제거하는 새니타이저는 앞쪽 목록만은 완벽하게 통과합니다.

## HTTP 요청하기

`@bundled/yaar`의 `httpFetch`를 사용하고, `app.json`에 `yaar://http`를 선언하세요. 권한이 없으면 크로스 오리진 요청은 403으로 거부됩니다(`"yaar://http"`와 `"yaar://http/"` 둘 다 동작).

```typescript
import { httpFetch } from '@bundled/yaar';

const res = await httpFetch('https://api.example.com/items?page=2');
if (!res.ok) throw new Error(`요청 실패: ${res.status}`);
const items = await res.json();
```

`fetch` 그 자체입니다. 표준 `Response`를 받으므로 `json()`, `text()`, `blob()`, `arrayBuffer()`와 실제 `Headers`를 그대로 쓸 수 있고(따라서 업스트림의 rate-limit·세션 헤더도 읽을 수 있습니다), 바이너리 본문도 손상 없이 전달됩니다.

| | 크로스 오리진 | 동일 오리진 / 상대 경로 |
|---|---|---|
| 경로 | YAAR 서버 측 프록시 | iframe 토큰을 실어 직접 요청 |
| CORS | 해당 없음 — 서버가 대신 호출 | 일반 브라우저 규칙 |
| `yaar://http` 필요 | 예 | 아니오 |
| 쿠키 | (세션, 앱) 범위의 쿠키 저장소 | iframe 자체 쿠키 |

크로스 오리진 요청에는 SSRF 검증, 도메인 허용 목록(새 도메인마다 사용자에게 한 번 확인), 10 MB 응답 제한, 30초 타임아웃이 함께 적용됩니다. `redirect: 'manual'`은 지원되며, `redirect: 'error'`는 표현할 수 없어 `'follow'`로 처리됩니다.

**`invoke('yaar://http', …)`보다 `httpFetch`를 쓰세요.** verb 형태는 `Response`가 아니라 YAAR 내부 응답 봉투를 반환하므로, 그 주위에 타입을 직접 선언하는 것은 소유하지 않은 내부 계약을 다시 타이핑하는 일입니다. verb 형태는 패치할 `window.fetch`가 없는 에이전트 측 코드용으로 남겨두세요.

**로그인이 있는 앱이라면 로그아웃 시 쿠키 저장소를 비우세요.** 프록시가 저장한 쿠키는 (세션, 앱) 키로 서버 측에 남으며 iframe 토큰이 만료되기 전까지 아무것도 이를 지우지 않습니다. 따라서 앱이 보관한 세션만 지우면 겉보기에만 로그아웃된 상태가 되고, 이후 요청은 계속 업스트림 세션을 실어 나릅니다. `await del('yaar://http')`은 호출한 앱 자신의 저장소만 비웁니다 — 키는 payload가 아니라 호출자의 토큰에서 유도되므로 한 앱이 다른 앱을 로그아웃시킬 수 없습니다.

페이지네이션, rate limit, JSON-RPC 프레이밍, 인증 갱신 같은 서비스별 관심사는 앱에 남습니다. `httpFetch`는 전송 계층만 표준화합니다.

## 안티패턴

앱 개발 시 피해야 할 일반적인 실수:

- **OAuth 클라이언트를 컴파일된 앱으로 만들지 마세요** — 토큰 교환에는 서버 측 `client_secret`이 필요합니다. 사용자가 개인 액세스 토큰을 제공하고 `invoke('yaar://config/app/{appId}', { config })`로 저장하는 API 기반 앱을 만드세요.
- **외부 서버가 실행 중이라고 가정하지 마세요** — `localhost:3000`이나 다른 포트에 백엔드는 없으며, 하드코딩한 localhost URL은 다른 호스트에서 서비스되는 순간 깨집니다.
- **프록시 응답 봉투를 직접 정의하지 마세요** — `httpFetch`를 쓰세요. [HTTP 요청하기](#http-요청하기) 참고.
- **저장 실패를 삼키지 마세요** — `appStorage.save()`를 `catch { /* ignore */ }`로 감싸면 UI는 "저장됨"이라고 표시한 채 데이터가 조용히 사라집니다. [저장 실패를 삼키지 마세요](#저장-실패를-삼키지-마세요) 참고.
- **새니타이즈하지 않은 HTML을 `innerHTML`에 넣지 말고, 새니타이저를 직접 만들지도 마세요** — [신뢰할 수 없는 HTML 렌더링](#신뢰할-수-없는-html-렌더링) 참고.
- **인라인 이벤트 속성을 생성하지 마세요** — `setAttribute('onerror', …)`는 어떤 새니타이저든 제거하므로, 파이프라인을 안전하게 만드는 순간 그 동작이 사라집니다. 삽입된 노드에 `addEventListener`를 쓰세요.
- **SDK 헬퍼를 다시 구현하지 마세요** — `@bundled/yaar`가 제공하는 것들은 [에러 처리 헬퍼](#에러-처리-헬퍼)에 정리되어 있고, `debounce`/`throttle`은 `@bundled/lodash`에 있습니다.
- **네이티브 `alert()` / `confirm()` / `prompt()`는 절대 쓰지 마세요** — 페이지와 브라우저를 조작 중인 에이전트까지 블로킹합니다. [다이얼로그 헬퍼](#다이얼로그-헬퍼) 참고.

### 외부 서비스 연동의 올바른 패턴

```
옵션 A: API 기반 앱 (API 래퍼에 적합)
  apps/recent-papers/agent/prompt.md → arXiv API, 조회 흐름 기술
  사용자가 API 키 제공 → invoke('yaar://config/app/{appId}', { config })로 저장
  AI가 invoke('yaar://http', ...)로 서비스 API 호출 → 윈도우에 렌더링

옵션 B: 컴파일된 앱 + AI 매개 API (풍부한 UI용)
  컴파일된 iframe 앱은 UI/표시만 담당
  AI 에이전트가 MCP 도구로 외부 API 호출 처리
  App Protocol이 둘을 연결:
    invoke(uri, { action: 'app_query' }) → AI에서 앱으로 표시 데이터
    invoke(uri, { action: 'app_command' }) → 앱에서 AI로 사용자 액션
```

## 에이전트 프롬프트 커스터마이징

각 앱은 사용자가 상호작용할 때 전용 **앱 에이전트**를 생성합니다. 앱 디렉터리의 세 파일이 서로 다른 세 독자에게, 서로 다른 세 시점에 전달됩니다:

| 파일 | 역할 | 사용 시점 |
|------|------|-----------|
| `agent/prompt.md` | 범용 기본 프롬프트를 **완전히 대체** | 정밀한 에이전트 동작이 필요한 앱 (예: devtools IDE) |
| `agent/hint.md` | **모니터 에이전트**의 시스템 프롬프트에 주입 | 오케스트레이터가 언제/어떻게 이 앱을 쓸지 아는 라우팅 힌트 |
| `agent/SKILL.md` | `describe('yaar://apps/{appId}')`가 반환 | *묻는 누구에게나* 주는 매뉴얼 — 프로토콜이 말할 수 없는 워크플로우와 순서 제약 |

앞의 둘만 프롬프트에 주입되고, `SKILL.md`는 필요할 때 읽히거나 아예 읽히지 않습니다. 추가되는 단계는 없습니다 — **파일 하나에 의미 하나.**

어느 쪽이든 `protocol.json` 매니페스트가 뒤에 덧붙습니다: state 키는 이름 + 설명 목록으로, 각 command는 `params` 스키마로부터 만들어진 호출 시그니처로 — `readFile(path: string|string[], startLine?: number, …)`처럼 선택 인자에는 `?`를 붙이고 enum은 그 값을 그대로 씁니다. 이 섹션은 그 턴이 어떤 프롬프트를 쓰든 항상 덧붙여지므로 **어느 프롬프트도 command의 params를 다시 적을 필요가 없습니다** — 다시 적으면 앱이 실제로 검증하는 스키마와 어긋납니다. per-param 설명이 필요할 때는 `describe()`가 여전히 전체 스키마를 반환합니다.

세 경로 모두 `app.json`에서 오버라이드할 수 있습니다 — `"agent": { "prompt": "agent/prompt.md", "hint": "agent/hint.md", "skill": "agent/SKILL.md" }` — 다만 이는 *기본값*이므로 대부분의 앱은 설정할 필요가 없습니다. 절대 경로나 상위로 올라가는 경로는 무시되고 기본값이 쓰입니다: `app.json`은 `yaar-dev`를 쥔 앱이면 다시 쓸 수 있고, 이 경로들은 곧 파일 읽기가 되기 때문입니다. `agent/hint.md`가 없으면 서버는 예전 루트의 `HINT.md`로 폴백하며 새 경로를 알리는 `[apps]` 경고를 남깁니다. 루트 `AGENTS.md`에는 이런 폴백이 **없으며**, 이는 의도된 것입니다(아래 참조).

### agent/hint.md (오케스트레이터 컨텍스트)

**모니터(오케스트레이터) 에이전트**의 시스템 프롬프트에 주입됩니다. 오케스트레이터에게 언제 이 앱으로 작업을 라우팅할지 알려주는 역할이며, 힌트는 설치된 앱과 자동으로 동기화됩니다 — 앱을 삭제하면 힌트도 사라집니다. 정적인 시스템 프롬프트에 두면 금세 낡아버릴, 앱에 의존적인 오케스트레이션 안내에 사용하세요:

```markdown
Use the devtools app for all app development tasks. The devtools app agent
is a specialist with direct access to the project filesystem, compiler,
and type checker.
```

### agent/prompt.md (완전 제어)

앱 에이전트의 전체 시스템 프롬프트가 이 파일로 대체됩니다. 특정 워크플로우가 필요할 때(devtools의 타입체크 → 컴파일 → 배포), 안티패턴과 도메인 규칙을 정의해야 할 때, 범용 프롬프트의 동작 가이드라인이 맞지 않을 때 사용하세요. 기본 프롬프트를 대체하므로 에이전트가 알아야 할 도구(`describe`, `query`, `command`, `relay`)를 직접 문서화해야 합니다. (`protocol.json`과, `controls`가 설정된 경우의 "Controllable Apps" 섹션은 여전히 자동으로 추가됩니다.)

### agent/SKILL.md (누구나 요청할 수 있는 매뉴얼)

`describe('yaar://apps/{appId}')`는 신원, `SKILL.md`, 그리고 프로토콜의 목차를 반환합니다. `SKILL.md`에는 생성된 프로토콜이 말할 수 없는 것만 쓰세요: 명령을 실행해야 하는 순서, 명령 셋을 엮는 워크플로우, 이 앱을 쓰지 *말아야* 할 때.

command나 state 이름을 제목이나 항목의 주어로 다시 적지 마세요 — 프로토콜은 `yaar://apps/{appId}/protocol`에서 서빙되고 배포마다 다시 생성되므로, 다시 적은 문장은 옆에 있는 스키마와 결국 어긋납니다. `bun run check:apps`가 이를 경고합니다(`skill-restates-protocol`, 권고 수준 — "`compile`을 `deploy`보다 먼저 실행하라" 같은 워크플로우 문장 속 이름은 이 파일의 존재 이유 그 자체이므로, 무엇이 걸렸는지 알려주고 판단은 맡깁니다).

[`docs/architecture/shell_to_userland.md`](../architecture/shell_to_userland.md)의 `SKILLS/` 디렉터리와 혼동하지 마세요: 그쪽은 `read('yaar://skills/{appId}/{topic}')`로 접근하는 네임스페이스 토픽 모음입니다.

### AGENTS.md (코딩 에이전트의 문서)

앱 루트의 `AGENTS.md`는 읽는 대상이 다른, 별개의 파일입니다: 코딩 에이전트가 디렉터리를 *편집*할 때 찾는 관례적인 이름이고, devtools가 바로 그 에이전트입니다. YAAR은 이 파일을 어디에서도 읽지 않습니다. 소스가 스스로 말해주지 못하는 것 — 아키텍처, 불변 조건, 왜 이 부분을 직접 구현했는지, 무엇을 바꾸면 무엇이 깨지는지 — 을 여기에 적으세요. 규모가 있는 앱이라면 하나쯤 두는 편이 좋고, 작은 앱에는 필요 없습니다. [`apps/devtools/AGENTS.md`](../../apps/devtools/AGENTS.md)가 실제 예시입니다.

`agent/prompt.md`와의 경계는 주제가 아니라 독자입니다. "`src/gizmo.ts`를 직접 구현한 이유는 번들 버전이 포인터 캡처를 놓치기 때문"은 `AGENTS.md`입니다. "머티리얼을 설정하기 전에 `addPrimitive`를 `{ kind: 'box' }`로 호출하라"는 `agent/prompt.md`입니다. 어느 쪽에서도 커맨드 시그니처를 다시 적지 마세요. `AGENTS.md`를 프롬프트로 쓰려던 앱은 범용 기본 프롬프트와 자신의 매니페스트를 받게 되며, 그것이 의도였다면 `agent/prompt.md`로 복사하라는 `[apps]` 안내가 로그에 남습니다.

clone과 deploy가 다른 소스 파일과 똑같이 이 파일을 운반하므로 왕복이 보장됩니다: devtools로 클론한 앱은 `AGENTS.md`와 함께 도착하고, 거기서 새로 쓴 파일은 배포 후에도 남습니다.

### 예시 구조

```
apps/my-app/
├── AGENTS.md         # (선택) 이 앱을 편집하는 코딩 에이전트를 위한 지침 — 런타임에는 읽히지 않음
├── agent/
│   ├── prompt.md     # 완전한 커스텀 에이전트 프롬프트 (선택, 고급)
│   ├── hint.md       # 모니터 에이전트 라우팅 힌트 (선택)
│   └── SKILL.md      # describe('yaar://apps/my-app')가 반환하는 매뉴얼 (선택)
├── app.json          # 메타데이터, 권한, 프로토콜 매니페스트
├── index.html        # 컴파일된 앱 (컴파일된 경우)
└── src/              # 소스 코드 (컴파일된 경우)
```

## `app.json` 참조

**소스:** `packages/server/src/features/apps/discovery.ts`

앱의 **id는 폴더 이름**입니다. `app.json`은 관대하게(lenient) 파싱됩니다 — 알 수 없는 필드와 타입이 잘못된 값은 조용히 무시되므로, 오타는 조용히 실패합니다.

| 필드 | 타입 | 용도 |
|------|------|------|
| `name` | `string` | 표시 이름 |
| `icon` | `string` | 이모지. 앱 폴더의 `icon.{png,jpg,svg,…}` 파일이 있으면 이를 대신 사용 |
| `description` | `string` | 런처에 표시됨; 에이전트에도 전달됨 |
| `version` | `string` | 게시 전마다 올릴 것 — 마켓플레이스는 더 높지 않은 버전을 거부 |
| `author` | `string` | 정보용 |
| `run` | `string` | iframe 진입점 — `dist/index.html` 또는 `yaar://apps/{id}/…` URI |
| `kind` | `"system"` | 보호되고 자동 신뢰되는 앱임을 표시. **번들 앱 전용** — 설치된 앱에서는 무시됨 |
| `createShortcut` | `boolean` | `false`면 런처에서 앱을 숨김 (`"hidden": true`도 동일한 의미) |
| `permissions` | `(string \| { uri, verbs? })[]` | 미리 부여된 URI 권한, 예: `"yaar://storage/"` 또는 `{ "uri": "yaar://http", "verbs": ["read"] }` |
| `bundles` | `string[]` | 게이트된 SDK(`yaar-dev`, `yaar-web`, `yaar-ml`) 사용 동의. 선언하지 않으면 컴파일러가 import를 거부 |
| `agentType` | `string` | 이 앱의 에이전트에 사용할 에이전트 프로필 오버라이드 |
| `agent` | `{ prompt?, hint?, skill? }` | 이 앱의 에이전트 문서 기본 경로 오버라이드 |
| `links` | `{ base }` | 이 앱이 렌더링하는 콘텐츠의 상대 href가 속한 사이트 — 링크 가드가 이를 기준으로 앵커를 해석합니다. [`apps/CLAUDE.md`](../../apps/CLAUDE.md#links-out-of-an-app) 참조 |
| `messaging` | `"all"` | 앱 에이전트가 모니터/사용자뿐 아니라 다른 앱/윈도우에도 `direct_message`할 수 있게 함 |
| `controls` | `(string \| { appId, commands?, background? })[]` | 이 앱이 조작할 수 있는 다른 앱. 호출자의 모니터에 대상 앱 윈도우가 없으면 하나를 열어 줍니다. `background: true`면 최소화 상태로 엽니다. **번들 앱 전용** |
| `streams` | `string[]` | 이 앱이 구독할 수 있는 스트림 소스(`"agents"`). **설치 시 승인 필요** |
| `subagents` | `{ max: number }` | 모니터당 이 앱이 띄울 수 있는 서브에이전트 상한. 16으로 클램프되며, 정수가 아니거나 `≤ 0`이면 "없음". **설치 시 승인 필요** |
| `variant` | `"widget" \| "panel"` | 윈도우 변형 |
| `dockEdge` | `"top" \| "bottom"` | 윈도우를 화면 가장자리에 도킹 |
| `frameless` | `boolean` | 윈도우 크롬 제거 |
| `windowStyle` | `object` | 윈도우에 적용할 CSS 오버라이드 |
| `defaultWidth` / `defaultHeight` | `number` | 초기 윈도우 크기(px) |

그 관대함에서 나오는 함정 하나: id는 항상 폴더 이름이며 여기에 `id`/`appId` 필드는 없습니다. 소스에서 `defineApp()`에 넘기는 `id`는 별개이며 실제로 *사용되고*, 폴더 이름과 일치해야 합니다.

## 앱 유형

### 컴파일된 앱

AI가 작성 → 컴파일 → 배포한 앱. iframe으로 실행됩니다.

```
apps/falling-blocks/
├── agent/
│   └── prompt.md    # 선택 — 매니페스트만으로 부족할 때만 작성
├── app.json         # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html       # 컴파일된 단일 HTML
└── src/             # 소스 코드
    ├── main.ts
    └── styles.css
```

### API 기반 앱

외부 API를 호출하는 앱: 컴파일된 소스 없이 `app.json`과 엔드포인트·인증 흐름·워크플로우를 기술한 `agent/prompt.md`만 둡니다. `POST /api/v1/posts`, `GET /feed` 같은 API 목록을 적어두면, "피드 보여줘"라고 할 때 AI가 API를 호출하고 결과를 윈도우에 표시합니다.

```
apps/moltbook/
├── app.json
└── agent/
    └── prompt.md    # API 엔드포인트, 인증 흐름, 워크플로우
```

### 프롬프트만 있는 수동 앱

같은 형태를 생성이 아니라 손으로 작성한 것입니다 — `apps/` 안에 `app.json`과 `agent/prompt.md`만 두고 소스는 없습니다.

## App Protocol

컴파일된 앱은 **App Protocol**을 통해 AI 에이전트와 양방향 통신할 수 있습니다. 앱이 자신의 기능(상태 조회, 명령)을 매니페스트로 선언하면, 에이전트가 런타임에 이를 발견하고 상태를 읽거나 명령을 실행합니다.

```
에이전트 → MCP 도구 → WebSocket → postMessage → iframe 앱
iframe 앱 → postMessage → WebSocket → MCP 도구 응답
```

### 앱에서 등록하기 — `defineApp()`

`src/main.ts`는 정확히 하나의 `export default defineApp({...})`로 끝납니다. 그 호출이 곧 앱입니다: 프로토콜을 등록하고(모듈 스코프에서 한 번, 뷰를 마운트하기 전에), 뷰를 마운트하고, 명령이 던진 무엇이든 `AppCommandError`로 정규화합니다. 앱이 직접 `render()`를 부르는 일은 없습니다.

```typescript
// src/store.ts
import { createSignal } from '@bundled/solid-js';
export const [items, setItems] = createSignal<string[]>([]);

// src/main.ts
import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { items, setItems } from './store';
import { App } from './app';

export default defineApp({
  id: 'my-app',                       // 앱 폴더 이름과 반드시 일치 — 빌드가 확인
  name: 'My App',
  state: {
    items: {
      description: '현재 아이템 목록',
      get: () => [...items()],        // 시그널 읽기, 복사본 반환
    },
  },
  commands: {
    addItem: {
      description: '아이템 추가',
      params: z.object({ text: z.string() }),   // 또는 JSON Schema 리터럴
      replay: 'never',                // 추가 동작 — iframe 재마운트 시 재실행 금지
      run: (p) => {                   // p는 { text: string }로 추론되고 이미 검증됨
        setItems([...items(), p.text]); // 불변 시그널 쓰기, render() 불필요
        return { ok: true };
      },
    },
  },
  view: App,                          // Solid 컴포넌트 — 또는 명령형 앱은 { mount(el) }
});
```

- **`state.get` / `commands.run`**이 핸들러이며, 나머지(`description`, `params`, `returns`, `aliases`, `events`, `onClose`, `onCapture`)는 이름 그대로입니다.
- **스키마.** `params`/`returns`/`schema`는 Zod 스키마(`@bundled/zod`, 함수형 Zod Mini API)나 평범한 JSON Schema 리터럴을 받습니다. Zod가 권장이며 단일 진실 공급원입니다: `run`의 파라미터 타입을 만들고, `run`이 보기 *전에* 호출을 검증하며(선언된 타입까지 — 원시 브리지는 이를 검사한 적이 없습니다), 빌드 시 `z.toJSONSchema()`로 `dist/protocol.json`에 접힙니다. `run`은 파싱된 값을 받으므로 기본값과 강제 변환이 이미 적용되어 있습니다.
- **`describe`.** `state`나 `commands` 항목은 선택적으로 문자열을 반환하는 `describe()`를 가질 수 있으며, 누군가 물을 때만 응답합니다 — `describe('yaar://windows/{id}/state/{key}')`. 정적 `description`이 말할 수 없는, 변하는 것에 쓰세요. 매니페스트에는 실리지 않으므로 값싼 호출은 계속 값쌉니다.
- **`replay`.** 윈도우의 iframe이 재마운트되면 서버가 기록된 명령을 다시 보냅니다. 두 번 적용되면 안 되는 명령(추가, 전송, 삭제)에는 `replay: 'never'`를 선언하고, 멱등한 명령은 생략하세요.
- **`view`.** Solid 컴포넌트는 `render`로 마운트되고, 자기 DOM을 직접 소유하는 명령형 앱은 `{ mount(el) { ... } }`를 넘기며 정리 함수를 반환할 수 있습니다(윈도우가 닫힐 때 `onClose` 뒤에 실행).
- **`keybindings`.** 조합키를 선언된 명령 이름에 매핑하는 선언적 단축키: `keybindings: { ArrowRight: 'nextPage', 'Ctrl+s': 'save' }`. 문법은 `[Ctrl+][Meta+][Alt+][Shift+]Key`이고 `KeyboardEvent.key` 이름을 대소문자 구분 없이 씁니다. `Ctrl`은 `Cmd`에도 매치됩니다. 바인딩된 명령은 params 없이 실행되므로 `params`가 없거나 전부 선택이어야 합니다. 디스패치는 윈도우가 포커스를 가진 동안 iframe 안에서 일어나며, Ctrl/Meta/Alt 없는 조합은 편집 가능한 엘리먼트가 포커스를 쥐면 억제되므로 맨 `ArrowRight`가 입력 커서 이동을 빼앗지 않습니다. 선언되지 않은 명령에 대한 바인딩, 해석 불가능한 조합, 한 조합의 두 가지 표기, 셸 예약 조합(`Shift+Tab`, `Ctrl+1-9`, `Ctrl+W`, `Ctrl+R`, `F5`)은 빌드가 거부합니다. 바인딩은 매니페스트에 실리므로 에이전트가 사용자에게 안내할 수 있습니다. 인자가 필요한 단축키는 명령형 `onShortcut(combo, handler)`를, 키를 누르고 있는 이동에는 `createKeyState`를 쓰세요.
- **나누기.** `state`/`commands` 맵은 다른 모듈에 두고 스프레드할 수 있습니다 — [도메인별로 프로토콜 나누기](#도메인별로-프로토콜-나누기) 참조. `export default` 자체는 `src/main.ts`에 있어야 합니다. 빌드가 Zod 스키마를 접기 위해 그것을 다시 읽기 때문입니다.

등록 방법은 `defineApp`뿐입니다: iframe SDK의 등록 진입점은 비공개이고 이 함수가 유일한 호출자입니다. 같은 윈도우에서 `defineApp()`을 두 번 부르면 조용히 덮어쓰는 대신 throw합니다. 저수준 `app.register()`는 제거되었으며, 남아 있는 호출은 이전 방법을 담은 메시지와 함께 빌드를 실패시킵니다.

### `defineAppCommand` — 스키마로부터 `run`의 params를 추론하기

명령은 파라미터 형태를 두 번 선언합니다: 에이전트가 읽는 `params` 스키마로 한 번, `run`의 TypeScript 타입으로 한 번. `defineApp({...})` 리터럴 안에서는 이 둘이 이미 묶여 있습니다 — `defineApp`은 각 `run`의 파라미터를 그 호출 지점에 쓰인 `params`로부터 유도하므로, `text`라고 말하는 스키마에 대해 `p.txt`를 쓰면 컴파일 에러입니다.

`defineAppCommand`는 리터럴 *바깥에* 선언된 명령에 대해 그것을 복원합니다:

```typescript
// src/protocol/items.ts
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';

export const itemCommands = {
  addItem: defineAppCommand({
    description: 'Add an item',
    params: z.object({ text: z.string() }),
    run: (p) => setItems([...items(), p.txt]),
    //                                   ^^^ 컴파일 에러: 'text'를 쓰려던 것 아닌가요?
  }),
};
```

런타임에서는 아무 일도 하지 않는 항등 함수입니다 — `dist/protocol.json`과 에이전트가 보는 모든 것은 그대로이고, 오직 컴파일러가 `run`을 검사하게 만들기 위해 존재합니다.

Zod 스키마(권장 — 호출 검증까지 해 줍니다)와 JSON Schema 리터럴을 모두 받습니다. JSON Schema에서는 `enum`, 스칼라 타입들, `array` + `items`, 임의로 중첩된 `object` + `properties`/`required`를 추론하며, `required`에 없는 키는 옵셔널로, `additionalProperties`만 있는 `object`는 `Record`로 추론됩니다. `anyOf`, `oneOf`, `$ref` 등은 `unknown`으로 추론되므로 그런 파라미터는 직접 타입을 명시하거나 래퍼 없는 객체 리터럴로 남겨두세요 — 래퍼를 쓰지 않은 디스크립터도 매니페스트에는 똑같이 도달합니다.

호출 형태는 리터럴로 유지하세요 — `defineAppCommand({ ... })`가 인라인 객체를 감싸는 형태여야 합니다. 빌드 타임 프로토콜 추출기는 평가기가 아니라 소스 파서입니다: 단일 식별자 호출을 그대로 지나쳐 디스크립터를 찾으므로, 계산된 콜리(computed callee)는 빌드를 실패시킵니다.

#### 도메인별로 프로토콜 나누기

`commands`나 `state` 맵은 다른 파일에 있는 디스크립터 맵들을 모아 구성할 수 있습니다. 추출기는 상대 경로 import와 스프레드를 따라가므로, 다음은 `dist/protocol.json`에 온전히 도달합니다:

```typescript
// src/commands/files.ts
export const fileCommands = {
  readFile: defineAppCommand({ description: 'Read a file', params: { ... }, run }),
};

// src/main.ts
import { defineApp } from '@bundled/yaar';
import { fileCommands } from './commands/files';
import { gitCommands } from './commands/git';

export default defineApp({
  id: 'devtools',
  name: 'DevTools',
  commands: { ...fileCommands, ...gitCommands },
  view: App,
});
```

조용히 지나가는 추론 함정 하나: 다른 모듈에서 스프레드된 명령도 매니페스트에는 인라인 명령과 똑같이 도달하지만, `run`의 파라미터는 자유 형식으로 넓어집니다 — 에러 없이 타입만 약해집니다. 그런 디스크립터는 `defineAppCommand`로 감싸거나, 파라미터 타입을 직접 명시하거나, 추론이 필요한 명령은 리터럴 안에 두세요.

한계는 정적으로 분석 가능한가이며, 이는 감수해야 할 제약이 아니라 강제되는 규칙입니다: **호출 결과**의 스프레드(`...buildCommands()`), npm 패키지에서 import한 디스크립터, `${...}` 템플릿 description, 또는 누락된 `description`은 `file:line:col`과 함께 컴파일을 실패시킵니다. 이는 의도된 것입니다 — 추출기가 건너뛴 명령이 런타임에는 여전히 동작하면서 모든 에이전트에게는 보이지 않는 상태가 되는 것이, 깨진 빌드보다 더 나쁜 유일한 결과이기 때문입니다.

#### 핸들러에 런타임 컨텍스트가 필요할 때

정적 분석 가능성과 등록별(per-registration) 컨텍스트는 서로 반대 방향으로 당깁니다: 디스크립터 맵은 최상위 `const`여야 하므로 팩토리의 파라미터를 클로저로 잡을 수 없고, 이를 `buildCommands(ctx)` 팩토리로 끌어올리면 추출기가 정확히 거부하는 그 호출 결과가 되어버립니다. `createProtocolContext`가 그 이음매입니다 — 디스크립터는 정적으로 남고, 컨텍스트는 등록 시점에 설치되며, 핸들러는 접근자를 통해 그것에 닿습니다:

```typescript
// src/protocol/context.ts
import { createProtocolContext } from '@bundled/yaar';

export const { set: setProtocolContext, get: ctx } =
  createProtocolContext<ProtocolContext>('slides-lite');

// src/protocol/deck.ts — 평범한 const이므로 추출기가 읽을 수 있음
export const deckCommands = {
  setDeck: defineAppCommand({
    description: 'Replace the whole deck',
    params: { ... },
    run: (p) => ctx().setDeck(p.deck),
  }),
};

// src/main.ts
export default defineApp({
  id: 'slides-lite',
  name: 'Slides',
  commands: { ...deckCommands },
  // 명령형 탈출구: 컨텍스트는 에디터가 만들어진 뒤에야 존재하고,
  // `mount`가 그것이 참이 되는 첫 순간입니다.
  view: {
    mount(el) {
      const editor = createEditor(el);
      setProtocolContext(editor.protocolContext);
      return () => editor.destroy();
    },
  },
});
```

`defineApp`은 마운트하기 전에 등록하므로 컨텍스트는 등록 *이후에* 설치됩니다 — 디스크립터가 `ctx()`에 닿는 시점은 명령이 실제로 실행될 때뿐이므로 문제가 되지 않습니다. 트레이드오프는 실재합니다: 컨텍스트는 모든 디스크립터가 공유하는 모듈 상태가 되므로, 문서 하나당 한 번 등록하는 앱 — 즉 일반적인 경우 — 에 적합합니다. 양쪽 경계 모두 조용히 넘어가지 않습니다: `set()` 전에 `get()`을 부르면 throw하고, *다른* 컨텍스트로 `set()`을 두 번 부르면 첫 등록의 핸들러를 조용히 다시 겨냥하는 대신 throw합니다.

### 에이전트에게 말 걸기

`defineApp()`의 `state`/`commands`는 에이전트가 *당신을* 읽는 방법입니다. 다음은 당신이 에이전트에게 닿는 방법이며, 전체 시그니처는 [`app_protocol_reference.md`](../reference/app_protocol_reference.md#iframe-sdk)에 있습니다:

```typescript
// 에이전트에게 보내는 자유 형식 메시지. 보통 iframe 안 사용자 액션 뒤에 씁니다.
app.sendInteraction('User clicked Save');
app.sendInteraction({ instructions: 'Summarize this', toMonitor: true, selection: text });

// defineApp({ events })로 선언된 채널에 fire-and-forget 이벤트.
// 선언되지 않았거나 구독되지 않은 채널은 서버 측에서 폐기됩니다.
defineApp({ /* ... */ events: { 'item-added': { description: 'A new item was added' } } });
app.emit('item-added', { text: 'Buy milk' });

// defineApp() 설정의 훅들.
defineApp({ /* ... */
  onClose: () => saveDraft(editor().value),             // 윈도우가 파괴되기 직전
  onCapture: () => sceneCanvas.toDataURL('image/png'),  // OS가 윈도우를 캡처할 때
});
```

- `sendInteraction`은 문자열, 또는 `instructions`와 `toMonitor`(이 윈도우의 앱 에이전트 대신 모니터 에이전트로 라우팅)에 임의의 페이로드 필드를 더한 객체를 받습니다.
- `app.emit(channel, payload, { wakeAgent: true })`는 **이 앱 자신의 에이전트**도 깨웁니다 — 에이전트가 시작해 놓고 기다리기를 그만둔 백그라운드 작업의 결과를 앱이 되돌려주어, 에이전트가 블로킹 대신 턴을 끝낼 수 있게 하는 방법입니다. 에이전트를 새로 만들지는 않으며, 상시 구독이 아니라 emit마다 결정합니다 — 같은 이벤트를 앱 자신의 UI가 냈다면 아무도 깨우지 않아야 하기 때문입니다.
- `onCapture`는 기본 전체 윈도우 스크린샷(DOM + 라이브 캔버스 픽셀 합성) 대신 쓸 data-URL 이미지를 반환하며, `null`을 반환하면 기본 동작으로 되돌아갑니다. async여도 됩니다. `preserveDrawingBuffer`가 없는 WebGL 캔버스나 뷰포트 밖에 렌더링되는 상태처럼 기본 캡처가 콘텐츠를 볼 수 없을 때 유용합니다.

### MCP 도구

에이전트는 *실행 중인* 앱을 윈도우 URI로 조작합니다. 동사 표(`describe`, `list`, `…/state/{key}`에 대한 `read`, `…/commands/{key}`에 대한 `invoke`)는 [URI 참조 → Windows](../reference/uri_reference.md#windows--yaarwindowswindowid)에, 페이로드 규칙과 앱 에이전트 전용 도구는 [`app_protocol_reference.md`](../reference/app_protocol_reference.md#invocation)에 있습니다. 여기서 알아둘 세 가지:

- 하위 경로 표기와 `action` 표기(`app_query`, `app_command`)는 같은 실행기를 탑니다 — 앞은 URI에서, 뒤는 페이로드에서 키를 지정할 뿐입니다. 앱을 처음 만난 에이전트는 윈도우를 `describe`하거나 bare 윈도우 URI로 `app_query`를 부르며, 둘 다 매니페스트를 반환합니다.
- `invoke('yaar://windows/{id}/commands/{key}', { …params })`는 페이로드 자체가 params입니다. **배열**을 넘기면 원소마다 한 번씩 순서대로 실행됩니다.
- `invoke('yaar://windows/{id}', { action: 'message', message })`는 **모니터 에이전트가 앱 에이전트에 위임**하게 해 줍니다 — `AppTaskProcessor`를 통해 사용자 메시지와 동일한 경로로 태스크를 큐잉하며, 필요하면 앱 에이전트를 그 자리에서 만듭니다.

```
invoke('yaar://windows/slides-lite', { action: 'app_query' })
invoke('yaar://windows/slides-lite', { action: 'app_query', stateKey: 'slideCount' })
invoke('yaar://windows/slides-lite', { action: 'app_command', command: 'setActiveIndex', params: { index: 2 } })
invoke('yaar://windows/slides-lite', { action: 'message', message: '이 덱을 요약해줘' })
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

각 앱은 `storage/apps/{appId}/`에 자기 폴더를 가집니다. 앱 코드에서는 `self`를 약칭으로 사용할 수 있으며, 서버가 iframe 토큰에서 실제 appId로 변환합니다. 권한 선언은 필요 없습니다 — 앱 자신의 스토리지, 데이터베이스, 서브에이전트는 자동으로 부여됩니다.

**격리된 별도 저장소가 아니라, 범위가 좁혀진 하위 트리입니다.** `yaar://apps/self/storage/x.json`과 `yaar://storage/apps/{appId}/x.json`은 같은 파일의 두 가지 표기입니다. 이 범위가 보장하는 것은 **설치된 다른 앱이 접근할 수 없다**는 것뿐입니다 — `yaar://storage/`를 선언한 마켓 앱은 설치 시점에 공유 트리로 제한됩니다(`http/uri-match.ts`의 `capForeignAppStorage`). 반면 비밀은 아닙니다: 사용자는 디스크에서 폴더로 보고, Storage 앱을 비롯해 YAAR와 함께 배포되는 앱은 전체 트리를 가지며, 모니터/세션 에이전트는 직접 접근합니다. 앱 자신의 상태를 두는 곳이지, 아무도 들여다보지 않을 것이라 기대하고 무언가를 숨겨 두는 곳은 아닙니다.

### 앱 코드에서 (`@bundled/yaar`)

```typescript
import { appStorage } from '@bundled/yaar';

await appStorage.save('data.json', JSON.stringify({ key: 'value' }));   // 실패 시 throw
const saved = await appStorage.trySave('data.json', json);              // 실패 시 false
const data = await appStorage.readJson<{ key: string }>('data.json');
const text = await appStorage.read('data.json');
const binary = await appStorage.readBinary('image.png');  // { data, mimeType, encoding }
const blob = await appStorage.readBlob('image.png');      // encoding 분기를 대신 처리
const files = await appStorage.list();  // [{ path, isDirectory, uri, mimeType?, size?, modifiedAt? }]
await appStorage.remove('data.json');
```

- `list()`는 **얕은 목록**입니다 — 직계 자식만 반환하므로 하위 디렉터리는 직접 재귀 순회해야 합니다. `size`와 `modifiedAt`은 선택 필드이며(디렉터리에는 `size`가 없습니다) 목록 자체에서 오므로 "이 에셋이 얼마나 큰가"를 알기 위해 따로 읽을 필요가 없습니다. `size`는 디스크상의 바이트이므로, `readJson`으로 읽어 다시 직렬화한 JSON과 정확히 일치하지는 않습니다.
- `readBinary`는 `encoding: 'base64' | 'text'`를 반환합니다 — `atob` 전에 확인하거나 `readBlob`을 쓰세요.
- **PDF에 대한 `readBlob()`은 PDF 바이트를 반환하지 않습니다.** 옵션을 받지 않으므로 서버의 페이지 래스터화 옵트인(`pdfPages`)이 이 경로에서는 절대 작동하지 않고, 기본 분기는 `PDF document with N page(s), N bytes.`라는 ASCII 문자열을 Blob으로 감싸 반환합니다. 원본 바이트가 필요하면 REST URL을 직접 fetch하세요 — 앱 범위 파일은 `/api/storage/apps/{appId}/{path}`에 있습니다.

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

`label`은 토스트에 표시될 데이터 이름입니다(`Couldn't save 초안: …`). `onError`를 넘기면 토스트 대신 앱 고유의 표시 수단(예: 인라인 상태 줄)을 쓸 수 있고, 어느 쪽이든 실패는 항상 로그로 남으므로 콘솔 추적을 잃지 않습니다. `createPersistedSignal()`은 쓰기를 `trySave`로 처리하며 동일한 옵션을 받으므로, 더 이상 저장되지 않는 시그널은 그 사실을 알립니다. 호출자가 throw를 실제로 처리하는 곳에는 `save()`를 그대로 두세요 — 예컨대 에이전트가 호출하는 커맨드 핸들러로 전파해 `AppCommandError`로 처리하는 경우입니다.

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

`debounce` / `throttle` 은 `@bundled/lodash` 에서 가져오세요 — 직접 만들지 마세요. 영문 가이드에는 이 목록 외에 `tryToast`, `safeParseOr`, `formatBytes`/`formatDuration`/`formatClock`, `downloadBlob`/`blobToDataUrl`/`toWebP`, `rasterize`, `fonts`, `sharedStorage`, `storagePath`, 서브에이전트(페르소나) 절이 더 있습니다 — [English version](../guides/app-development.md) 참조.

### 다이얼로그 헬퍼

네이티브 `alert()` / `confirm()` / `prompt()` 는 절대 쓰지 마세요 — 디자인이 이질적이고,
페이지 전체를 블로킹하며, 브라우저를 조작 중인 에이전트까지 멈춥니다. `@bundled/yaar` 가
내장 `y-modal` 클래스로 스타일된 프로미스 기반 대체를 제공합니다 (Escape 취소, Enter 확인,
배경 클릭으로 닫힘). `alert()` 의 대체는 `showToast` 입니다 — 버튼 하나짜리 모달은 토스트가
이미 하는 말을 하려고 포커스를 뺏을 뿐입니다:

```typescript
import { showConfirm, showPrompt, showToast } from '@bundled/yaar';

showToast('내보내기 완료.', 'success');

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
describe('yaar://apps/my-app/storage/data.json')
delete('yaar://apps/my-app/storage/data.json')
```

`describe`는 그 **경로 자체**를 설명합니다: 없으면 에러, 폴더면 `{ kind: 'directory', entries, totalSize, verbs }`, 파일이면 `{ kind: 'file', size, modifiedAt, mimeType, verbs }`(PDF는 페이지 수와 `pdfText` / `pdfPages` 읽기 옵션이 추가됩니다). `…/storage` 루트만 예외로, 앱 스토리지 매뉴얼과 루트 항목 수로 답합니다. 존재하지 않는 디렉터리에 대한 `list`는 빈 성공이 아니라 **에러**입니다 — 다만 네임스페이스 루트는 예외로, 앱의 `storage/`는 앱이 존재하는 순간부터 존재하므로 아무것도 쓰지 않은 상태의 목록은 "없음"이 아니라 비어 있음입니다.

서버 측 전체 표면(write/copy/edit/grep 페이로드, 마운트, REST 경로, PDF 옵션): [`docs/reference/storage_api_reference.md`](../reference/storage_api_reference.md).

## 앱 전용 데이터베이스 (`appDb`)

구조화된 레코드를 위해 각 앱은 `storage/apps/{appId}/data.db`에 SQLite 데이터베이스도 갖습니다. `appStorage`와 달리 쿼리, 카운팅, 페이지네이션, 전문 검색(full-text search)을 서버 측에서 지원하므로 JSON을 통째로 불러와 필터링할 필요가 없습니다. 바이너리 blob과 단순한 단일 파일은 계속 `appStorage`에 두세요. 설계, 필터→SQL 변환, 저장소 종류별 구분: [`docs/guides/sqlite.md`](./sqlite.md).

```typescript
import { appDb } from '@bundled/yaar';

interface Note { title: string; tags: string[] }
const notes = appDb.collection<Note>('notes');

const id = await notes.insert({ title: 'Hello', tags: ['intro'] }); // → 생성된 _id
await notes.insertMany([{ title: 'A', tags: [] }, { title: 'B', tags: [] }]);

const one = await notes.get(id);                    // → doc | null (_id, _created_at, _updated_at 포함)
const page = await notes.find(
  { tags: 'intro' },                                // Mongo 스타일 필터, 필드는 AND로 결합
  { sort: { _created_at: -1 }, limit: 20, offset: 0 },
);
const hits = await notes.search('hello world');     // FTS5 전문 검색, 가장 잘 맞는 것부터

await notes.update(id, { title: 'Updated' });       // 얕은 병합
await notes.remove(id);
await notes.removeWhere({ tags: 'draft' });         // 필터는 비어 있으면 안 됨
const n = await notes.count({ tags: 'intro' });

await appDb.collections();                          // → ['notes', ...]
await appDb.drop('notes');                          // 컬렉션 + 문서 삭제

// 쿼리를 추적하는 Solid 시그널. docs()는 이 헬퍼들을 통한 변경에 다시 렌더링되고,
// 외부 변경(에이전트, 다른 윈도우)은 verb 구독을 통해 도착합니다.
const [docs, { insert, update, remove, refresh }] = appDb.createReactiveCollection<Note>(
  'notes', { sort: { _created_at: -1 }, limit: 50 },
);
```

필터는 정확히 일치, 배열 포함(스칼라 동등 비교와 같은 문법), `$gt`/`$gte`/`$lt`/`$lte`, `$ne`(필드가 없는 문서도 매치), `$in`, `$exists`, 그리고 중첩 객체로 들어가는 점 표기 경로를 받습니다 — 표는 [`sqlite.md`](./sqlite.md#필터-문법)에 있습니다.

### 에이전트에서 (MCP 도구)

에이전트는 파일 전체를 불러올 필요 없이 앱 데이터를 직접 쿼리할 수 있습니다:

```
list('yaar://apps/memo/db')                                            → 컬렉션 이름 목록
read('yaar://apps/memo/db/notes')                                      → 최근 문서
read('yaar://apps/memo/db/notes/{id}')                                 → 문서 하나
invoke('yaar://apps/memo/db/notes', { action: 'find', filter: { tags: 'important' }, limit: 5 })
invoke('yaar://apps/memo/db/notes', { action: 'search', query: 'quarterly report' })
invoke('yaar://apps/memo/db/notes', { action: 'insert', doc: { ... } })  → { _id }
invoke('yaar://apps/memo/db/notes/{id}', { action: 'update', patch: { ... } })
invoke('yaar://apps/memo/db/notes', { action: 'count' })                 → { count }
delete('yaar://apps/memo/db/notes/{id}')                                 → 문서 삭제
delete('yaar://apps/memo/db/notes')                                      → 컬렉션 삭제
```
