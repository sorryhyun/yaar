# onnxruntime-web 1.30.0 업그레이드 노트

조사일: 2026-09-20 · 현재 고정 버전: **1.27.0** (`package.json:35` catalog `^1.27.0`, `bun.lock:1037`)
→ 1.28 / 1.29 / 1.29.1 을 건너뛰는 점프. 시맨틱 레인지상 `bun update onnxruntime-web` 한 번이면 락파일만 바뀜.

## 1. 배선은 안 깨진다

1.27.0 과 1.30.0 의 `dist/` 파일 목록(jsdelivr)이 **58개 전부 동일**. YAAR 가 이름으로 직접 참조하는 셋이 그대로:

| 참조처 | 파일 |
| --- | --- |
| `ORT_URL` (`packages/compiler/src/shims/yaar-ml.ts:56`) | `ort.webgpu.bundle.min.mjs` |
| `ORT_WASM_URL` (`yaar-ml.ts:73`) | `ort.wasm.bundle.min.mjs` |
| `env.wasm.wasmPaths = '/api/ml-runtime/'` (`yaar-ml.ts:194`) | `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` |

`/api/ml-runtime/{file}` 라우트와 `ML_RUNTIME_FILE` 정규식, `config/assets.ts` 의 dist 해석,
`exe-assets.ts` 의 번들 경로 전부 그대로 통과. 패키징 측면에선 drop-in.

## 2. 방향성 — 셰임의 베팅이 상류 공식 노선이 됐다

- **1.29 에서 WebGL + JSEP deprecation 공식 발표.** native(Dawn) WebGPU EP 가 권장 경로.
- `yaar-ml.ts` 상단 주석의 판단(패키지 기본 export `.` = 구 JSEP EP, fp16 alias-view 할당자 결함 →
  `/webgpu` native 사용)이 업스트림 방향과 일치하게 됐음.
- **다만 1.30 에서 아직 flip 되지 않았다.** 계획(issue #29716)은 2단계:
  Phase 1 deprecation 공지 → Phase 2 에서 기본 export 를 native 로 전환하면서 한 릴리스 동안만
  `/jsep` 탈출구 유지, `/all` 은 JSEP flip 과 WebGL 제거가 둘 다 착지한 뒤에야 단일 alias 로 합쳐짐.
- **후속 작업 트리거:** flip 이 실린 릴리스가 나오면 `yaar-ml.ts` 의 "TWO flavors" 주석과
  "기본 export 를 피한다"는 전제를 다시 써야 한다.

## 3. YAAR 가 체감할 변화 (1.28 → 1.30 누적)

### 정합성 수정 — native WebGPU EP, 즉 YAAR 가 쓰는 쪽
- LayerNorm / GELU·BiasGELU fusion 활성화, Elu·contrib GELU 의 transpose-optimizer 처리
  → **FP16 추론 정합성 수정**으로 명시
- writable device-allocator 버퍼 zero-init
- partial tile 에서 subgroup-matrix out-of-bounds load 수정
- MatMul 파이프라인 캐시 키 오류 + 1D-dispatch 셰이더 fast path 수정
- 사용자 제공 `GPUDevice` 동기화 수정

> 셰임에 기록된 증상(anima DiT 의 adaLN `Split→Unsqueeze→broadcast` 가 블록당 ~10배로 부풀어
> residual overflow → 전부 NaN)은 상류 fp16 overflow 이슈군(#26732 Gemma 3 fp16/q4f16,
> #32629 mixed-type LayerNorm)과 모양이 같다. **고쳐졌다고 단정할 근거는 없지만 재측정 가치는 있다.**

### 성능
- convolution fusion 에 활성화 8종 추가, im2col 경로 fused activation
- convolution weight prepacking, pointwise conv 에 subgroup-matrix MatMul 재사용
- MatMulNBits wide tile + subgroup shuffle, subgroup size 32 고정, WASM 빌드에서도 subgroup-matrix 경로 활성화
- vec4 정렬된 `Split` 벡터화, Dawn 파이프라인 컴파일 워커를 CPU 수만큼 스케일
- (LLM 전용이라 현재 YAAR 와 무관: PagedAttention 개선, INT8 KV-cache block quantization, GPT-OSS 지원)

### 안 바뀌는 것
- `numThreads = 1` — iframe 이 cross-origin isolated 가 아니라 SharedArrayBuffer 불가. 그대로.
- `env.wasm.proxy = true` 의 제약(`preferredOutputLocation` 불가, GPU-resident 입력 텐서 불가)도 그대로.
  셰임이 이미 둘 다 피해 가므로 건드릴 것 없음.

## 4. 업그레이드 절차

```bash
bun update onnxruntime-web            # 락파일만 1.27.0 → 1.30.0
bun run --filter @yaar/server test    # ml-runtime-artifact.test.ts 포함
bun run --filter @yaar/tests test     # ml-runtime-remote-auth
```

그다음 실제 앱에서 fp16 모델을 돌려 확인할 것:
1. native EP 경로가 여전히 정상인지
2. 기본 export 회피(= `/webgpu` 플레이버 고정)가 아직 필요한지 — 필요 없어졌다면 셰임 주석 정리

## 참고 링크

- [ONNX Runtime v1.30.0 release notes](https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0)
- [ONNX Runtime v1.29.0 release notes](https://github.com/microsoft/onnxruntime/releases/tag/v1.29.0)
- [JSEP/WebGL deprecation plan (#29716)](https://github.com/microsoft/onnxruntime/issues/29716)
- dist 목록: [1.30.0](https://data.jsdelivr.com/v1/packages/npm/onnxruntime-web@1.30.0) · [1.27.0](https://data.jsdelivr.com/v1/packages/npm/onnxruntime-web@1.27.0)
- [fp16/q4f16 Gemma 3 WebGPU overflow (#26732)](https://github.com/microsoft/onnxruntime/issues/26732)
- [mixed-type LayerNormalization fix (#32629)](https://github.com/microsoft/onnxruntime/pull/32629)
