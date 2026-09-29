# `@bundled/yaar-ml` — 브라우저 내 모델 런타임

> [English version](../guides/yaar_ml_runtime.md)

**소스:** `packages/compiler/src/shims/yaar-ml.ts`, `packages/compiler/src/bundled-types/index.d.ts`, `packages/server/src/http/routes/ml-runtime.ts`, `packages/server/src/config.ts`

*YAAR 앱 iframe 안에서* 모델을 실행합니다 — Python도, 별도 설치도 없이 — WebGPU를
사용하며(단일 스레드 wasm 폴백 포함). 가중치는 한 번 다운로드되어 브라우저에 캐시되므로,
ML 앱은 자신의 모델을 함께 배포하고 데스크톱이 구동되는 어디에서든 실행할 수 있습니다 —
원격/헤드리스 모드도 포함해서요.

다운로드해서 브라우저 탭 안에 들어갈 만큼 작은 모델들을 대상으로 합니다. CUDA/MPS가
필요한 프론티어 모델은 범위 밖입니다.

이 SDK는 **게이트**되어 있습니다 — `app.json`에 선언해야 합니다:

```json
{ "bundles": ["yaar-ml"] }
```

---

## 빠른 시작

```typescript
import { capabilities, session, run, Tensor } from '@bundled/yaar-ml';

const caps = await capabilities();
if (!caps.webgpu) console.warn('No WebGPU — falling back to (slower) wasm');

// Downloads + caches weights, creates a WebGPU session (wasm fallback in `auto`).
const s = await session('https://huggingface.co/<repo>/resolve/main/model.onnx', {
  backend: 'auto',
  onProgress: (p) => console.log(`${(p.ratio * 100) | 0}%`),
});

const input = new Tensor('float32', new Float32Array(1 * 3 * 224 * 224), [1, 3, 224, 224]);
const out = await run(s, { pixel_values: input });
console.log(out);
```

## API

| 함수 | 용도 |
|---|---|
| `capabilities()` | `{ webgpu, f16, maxBufferSize, maxStorageBufferBindingSize, estMemoryBudget, adapter }`. 절대 던지지 않으며, 캐시됩니다. |
| `session(model, opts?)` | 모델 **URL** 또는 원시 `ArrayBuffer`/`Uint8Array`로부터 `InferenceSession`을 생성(또는 메모이즈된 것을 반환)합니다. `opts.backend`: `'webgpu' \| 'wasm' \| 'auto'`(기본값 `auto`). `opts.onProgress`는 가중치 다운로드 진행률을 보고합니다. |
| `run(session, feeds, options?)` | 추론을 실행합니다. `feeds`는 입력 이름 → `Tensor`의 맵입니다. 출력 맵으로 resolve됩니다. |
| `fetchWeights(url, opts?)` | 가중치를 `ArrayBuffer`로 다운로드하며, URL 기준으로 IndexedDB에 캐시되고 `opts.onProgress`로 스트리밍됩니다. `opts.force`는 다시 다운로드합니다. 동일 오리진 URL은 직접 읽으며 IndexedDB에는 미러링하지 않습니다. |
| `prefetchWeights(files, opts?)` | 가중치 파일을 서버 측 **디스크**에 스트리밍하고(재개 가능), 다시 읽어올 동일 오리진 URL을 반환합니다. [디스크로 프리페치](#디스크로-프리페치)를 참조하세요. |
| `weightUrl(dest)` | 프리페치된 `dest`를 읽어오는 `/api/storage/…` URL입니다. |
| `clearCache(url?)` | 캐시된 가중치 파일 하나를, 또는 캐시 전체를 제거합니다. |
| `dispose(session)` | 세션의 네이티브 리소스를 해제합니다. |
| `releaseSessions(match)` | 모델 URL이 일치하는 모든 세션을 해제**하고 메모를 지웁니다**. GPU 메모리를 해제하는 올바른 방법입니다 — [모델 교체하기](#모델-교체하기)를 참조하세요. |
| `Tensor`, `env`, `ort` | onnxruntime-web의 `Tensor` 생성자, `env`(고급 튜닝), 그리고 원시 네임스페이스입니다. |

## 동작 원리 (플랫폼 배관)

SDK는 onnxruntime-web을 런타임에 서버의 `/api/ml-runtime/` 라우트에서 불러옵니다. 모든 URL에
`?v=<ortVersion>`이 붙기 때문에 ORT를 업그레이드하면 브라우저에도 반영됩니다. 가중치는 동일
오리진 스트리밍 프록시(`/api/ml-weights`, SSRF 방지와 허용 목록 적용)를 거쳐 IndexedDB 캐시에
들어가거나, `prefetchWeights`로 디스크에 저장됩니다. 세션은 ORT 워커에서 단일 스레드로
실행됩니다(COOP/COEP 없음). macOS 서버에서 WebKit 페이지가 쓰는 경우(`YAAR_ML_COMPUTE`)에는
`session()`/`run()`이 같은 API 그대로 서버의 헤드리스 Chrome에서 실행됩니다. 설계와 그 이유:
[ML 런타임 아키텍처](../architecture/ml_runtime.md) (영문).

원격 연산에서 앱이 직접 챙겨야 할 것이 두 가지 있습니다:

- **가중치는 직접 가져오지 말고 이름으로 넘기세요.** `externalData`에 URL이나
  `weightRange()`를 주면 서버의 Chrome이 서버에서 직접 읽습니다. 앱이 직접 가져온 바이트는
  업로드해야 하는데, 수 GB 모델이라면 로드 시간의 대부분이 여기에 들어갑니다.
- **실행 사이에 넘기는 활성값은 `keep`으로 지정하세요.** 지정하지 않으면 활성값마다 페이지를
  한 번씩 왕복합니다. 남겨 둔 출력은 `.data`가 아니라 `await t.getData()`로 읽으세요.

`ort`를 직접 쓰는 코드(onnxruntime을 직접 import하는 워커)는 항상 로컬에서 실행됩니다.

## 디스크로 프리페치

IndexedDB 캐시는 올바른 기본값입니다 — 호출 한 번이면 되고, 서버 상태도 없고, 정리할 것도
없습니다. 하지만 이는 *브라우저*의 캐시입니다 — 사이트 데이터를 지우면 사라지고, 쿼터
압박이 오면 축출되며, 그 안의 어떤 것도 다른 탭의 첫 렌더까지 살아남지 못합니다. 한 번
받아서 계속 유지하고 싶은 모델이라면, `prefetchWeights`가 이 머신의 스토리지로 대신
스트리밍합니다:

```typescript
import { prefetchWeights, session } from '@bundled/yaar-ml';

const [modelUrl] = await prefetchWeights(
  [{ url: `${HF}/model.onnx`, dest: 'apps/self/weights/model.onnx', bytes: 77_000_000 }],
  { onProgress: (p) => setStatus(`${((p.overallLoaded / p.overallTotal) * 100) | 0}%`) },
);

const s = await session(modelUrl); // reads off disk, no second copy in IndexedDB
```

- 브라우저는 바이트를 전혀 건드리지 않습니다. `POST /api/storage/{path}`는 전체 본문을
  `MAX_UPLOAD_SIZE`(50MB) 아래로 버퍼링하므로, *서버*가 병렬 Range 요청으로 원격 → 디스크로
  스트리밍하고 SDK는 진행률을 폴링합니다.
- **재개 가능.** 전송이 중단되면 `.part` 파일이 남고 멈춘 지점부터 이어받습니다. 이미
  디스크에 있는 파일은 즉시 완료되므로, 부팅할 때마다 이를 호출하는 것이 의도된 사용법입니다
  — 이것은 인스톨러가 아니라 "모델이 여기 있는지 확인"하는 것입니다.
- `dest`는 스토리지 상대 경로이며 `apps/self/`는 해당 앱 자신의 디렉터리로 해석됩니다.
  대상 경로는 다른 스토리지 쓰기와 동일하게 권한 검사를 받으므로, 앱은 이미 쓸 수 있는
  곳에만 프리페치할 수 있습니다.
- 이후로는 오프라인: 다시 읽어오는 URL은 동일 오리진이며 디스크에서 바로 서빙되므로,
  `session()`은 다시는 네트워크를 건드리지 않습니다.

## 모델 교체하기

`session()`은 URL 기준으로 메모이즈하며, **ORT는 세션이 가비지 컬렉션되어도 네이티브/GPU
메모리를 해제하지 않습니다** — 오직 명시적인 해제만이 그렇게 합니다. 이 두 사실이 결합해
함정을 만듭니다: `dispose(s)`는 네이티브 쪽을 해제하지만 메모는 URL로 키가 걸려 있으므로,
나중에 `session(sameUrl)`을 호출하면 이미 해제된 핸들을 돌려받을 수 있습니다. 대신
`releaseSessions`를 사용하세요 — 둘 다 처리합니다:

```typescript
await releaseSessions((url) => url.includes('_det_')); // drop the detector
await releaseSessions(() => true);                     // drop everything
```

이는 두 개의 모델을 쥐고 있는 앱 — 감지기(detector)와 인식기(recognizer), 작은 변형과
큰 변형 — 이 다음 모델을 로드하기 전에 필요한 처리입니다. 원시 바이트로부터 생성된 세션은
결코 메모이즈되지 않으므로, 그런 세션은 `dispose`로 해제하세요.

## 기능 & 한계 — "무엇이 들어맞는가"

Tier 1은 두 개의 상한선에 의해 제약됩니다:

1. **GPU 버퍼 한계.** `capabilities().maxStorageBufferBindingSize`가 텐서당 하드
   상한입니다(GPU에 따라 보통 약 128MB–2GB). 이 한계를 넘는 단일 가중치/활성화 버퍼는
   할당할 수 없습니다. 모델이 이를 초과하면 `session()`은 조용한 OOM 대신 친절한
   *"이 모델은 당신의 GPU에 너무 큽니다"* 에러를 던집니다. 완화책: 더 작거나 더 강하게
   양자화된 모델을 고르거나, 가중치를 샤딩하세요.
2. **탭 메모리.** 모델 전체 + 활성화가 탭의 예산에 들어맞아야 합니다. 저사양 GPU와
   모바일은 데스크톱보다 훨씬 일찍 한계에 부딪힙니다.

**알려진 적합 대상** (다운로드 → 캐시 → WebGPU → 출력):

- 임베더 / 시맨틱 검색(예: all-MiniLM, int8) — 수십 MB.
- 이미지 분류기(MobileNet/ResNet ONNX) — 수십 MB.
- 소형 음성 모델(whisper-tiny/base) — 온디바이스 전사.
- 배경 제거(U²-Net / MODNet).
- 소형 디퓨전(SD-Turbo int8) — 계획의 파이프라인 검증 대상.
- OCR(PP-OCRv6 인식기, 77MB) — WebGPU에서 줄당 약 30ms, 13–15px 다크 테마 UI 텍스트에서
  정확함. 번들 `ocr` 앱 참조.

**int8 가중치 / f16 연산**을 선호하세요. 반정밀도에 의존하기 전에 `capabilities().f16`을
확인하세요 — 모든 어댑터가 `shader-f16`을 노출하지는 않습니다.

## 첫 로드 UX

첫 실행은 수십~수백 MB를 다운로드합니다. 항상 `onProgress`를 실제 진행률 바에 연결하세요.
이후 로드는 IndexedDB에서 서빙됩니다(오프라인 가능). IndexedDB 캐시는 약 4GB 예산을
넘으면 가장 오래된 것부터 스스로 축출합니다.

## 주의 사항

- **먼저 기능을 감지하세요.** `capabilities()`를 호출하고 `webgpu`가 false일 때 우아하게
  성능을 낮추세요 — `backend: 'auto'`가 이미 wasm으로 폴백하지만, wasm은 훨씬 느리므로
  사용자에게 알려주세요.
- **허용 목록.** `allow_all_domains`가 꺼져 있고 모델 호스트가
  `config/curl_allowed_domains.yaml`에 없으면, 첫 가중치 다운로드 때 사용자에게 묻고
  ("Allow Domain Access") 승인되면 호스트를 추가합니다. 사용자가 거부하거나 물어볼 세션이
  없을 때만 실패하니, 헤드리스로 쓸 때는 호스트를 미리 등록하세요.
- **번들 크기.** 늘어나지 않습니다. SDK는 ORT의 타입만 import하고 모듈(약 118KB)은
  런타임에 `/api/ml-runtime/`에서 불러옵니다. `.wasm` 바이너리(WebGPU 약 27MB, CPU 약
  14MB)는 거기서 한 번 서빙되고 브라우저에 캐시됩니다.

- **동적 차원을 몇 개의 버킷에 맞춰 스냅하세요.** WebGPU 실행 프로바이더는 **구체적인 입력
  형태마다** 커널을 컴파일합니다. 동적 차원을 가진 모델 — 대부분의 시퀀스 모델과 비전
  모델이 그렇습니다 — 은 임의의 형태를 입력하면 한 번의 컴파일이 호출마다의 컴파일로
  둔갑합니다. 작고 고정된 집합을 골라 가장 가까운 값으로 패딩하세요:

  ```typescript
  const BUCKETS = [160, 320, 480, 640, 960, 1280, 1920, 2400];
  const width = BUCKETS.find((b) => b >= needed) ?? BUCKETS.at(-1)!;
  ```

  40줄짜리 페이지를 한 줄씩 40개의 서로 다른 너비로 인식하면 40번의 컴파일을 치릅니다.
  버킷을 쓰면 최대 8번, 그것도 한 번만 치릅니다. 버킷은 **배치 처리**도 가능하게 합니다 —
  동적 배치 차원이 있으면 한 버킷에 속한 모든 크롭이 단일 `run` 호출로 처리될 수 있습니다
  — 이것이 보통 두 이점 중 더 큰 쪽입니다.

- **모델의 출력 형태를 그것을 인덱싱하는 데 쓰는 테이블과 대조해서 검증하세요.** 가중치를
  어휘, 라벨 집합, 클래스 목록과 짝짓는 모든 앱에는 에러가 아니라 *출력물*을 만들어내는
  실패 모드가 하나 있습니다: 잘못된 테이블입니다. 문자 수준 검사 한 줄이면 첫 실행에서
  이를 잡아냅니다:

  ```typescript
  const vocabSize = session.outputMetadata /* … */ ?? logits.dims.at(-1)!;
  if (vocabSize !== charset.length + 1) {
    throw new Error(`Model expects a ${vocabSize - 1}-char dictionary, got ${charset.length}`);
  }
  ```

  이는 가정이 아닙니다: PP-OCRv6의 `tiny` 인식기는 6,904자 사전을 탑재하는 반면
  `medium`/`small`은 18,708자를 탑재합니다. 잘못 짝지어지면 자신만만하고 유창한 헛소리로
  디코딩됩니다 — 이 검사가 OCR 앱의 첫 실행에서 이를 잡아냈습니다.

## 서버 / 설정 옵션

- `YAAR_ML_RUNTIME_DIR` — ORT `.wasm`/`.mjs` 아티팩트가 서빙되는 위치를 오버라이드합니다.
  기본값은 설치된 패키지의 `dist/`이고, 번들 exe는 바이너리에 내장된 사본을 서빙하며 옆의
  `./ml-runtime/` 폴더는 그 사본에 없는 파일만 채웁니다.
