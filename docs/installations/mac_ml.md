# In-browser ML on macOS

**Source:** `packages/compiler/src/shims/yaar-ml.ts`, `packages/server/src/desktop-window/host.ts`, `packages/lib/src/webview/native/webview_extras.mm`

Apps that run models (anima, transcribe, image23d, … through `@bundled/yaar-ml`) run them
*in the page*, on the page's WebGPU. On macOS that page is YAAR's own window, which is WebKit
([mac.md](./mac.md)), so ML speed on a Mac is whatever WebKit's WebGPU delivers. This page
records what that is, measured on 2026-09-29, and how far it sits from the same Mac running
Chrome — and what YAAR does about it: by default, a yaar-ml app in the window runs its
sessions in the server's headless Chrome ([Remote compute](#remote-compute-in-the-servers-chrome)).

---

## What a model can run on, in the installed window

| Backend | In YAAR's window (WKWebView, macOS 26.6.2) | |
|---|---|---|
| **WebGPU** | ✅ | Metal underneath. `shader-f16` and `timestamp-query` are available; **`subgroups` is not**. `maxBufferSize` is 2 GB |
| **WASM (CPU)** | single-threaded only | SIMD works, but the page is not `crossOriginIsolated`, because YAAR sends no COOP/COEP. That means no `SharedArrayBuffer`, so ORT runs one thread. Far too slow for a 2B-parameter DiT |
| **WebNN** | ❌ | No `navigator.ml`, so there is no page-level route to CoreML or the Neural Engine |
| **Metal / MPS / CoreML / MLX** | ❌ from a page | A page reaches the GPU only through WebGPU. The YAAR server is a native process and *could* run these, but no such path exists |

WebGPU is the only real option inside the window, and it is what `yaar-ml` uses. The runtime is
onnxruntime-web 1.30's `/webgpu` flavor: ORT's C++ WebGPU execution provider compiled to wasm.

## WebKit has no subgroups, at all

ORT 1.30 carries kernels that need GPU features WebKit does not offer:

- **Subgroup kernels** (`subgroupShuffle`, `subgroupAdd`), mostly in quantized MatMul
  (`MatMulNBits`) and some attention paths.
- **Subgroup-matrix f16 GEMM kernels** (`subgroupMatrixMultiplyAccumulate`), which map to Apple's
  `simdgroup_matrix` hardware path.

What each engine on the same Mac exposes:

| | `subgroups` | `chromium-experimental-subgroup-matrix` |
|---|---|---|
| WKWebView (YAAR's window) | ❌ | ❌ |
| Chrome 154, default | ✅ (size 32) | ❌ |
| Chrome 154, `--enable-unsafe-webgpu` | ✅ | ✅ |

WebKit is not hiding the feature behind a switch; it does not implement it:

- None of the 599 `WKPreferences` feature flags mentions subgroups. The only WebGPU flags are
  `WebGPUEnabled`, `WebGPUHDREnabled` and `WebXRWebGPUBindingsEnabled`.
- The system's WebGPU feature-name tables, both WebCore's and `WebGPU.framework`'s, list 22
  names from `bgra8unorm-storage` to `timestamp-query`, and `subgroups` is not among them.
- No subgroup WGSL builtins (`subgroupShuffle`, `subgroup_invocation_id`) appear in the
  system's shared library cache.

So until Apple ships subgroups, no setting in YAAR can give the window those kernels.

---

## Measured: anima on an M1 Pro

The machine was an M1 Pro (16-core GPU, 32 GB), running macOS 26.6.2 with Chrome 154 and
onnxruntime-web 1.30. The test was anima 0.4.1 at 512×512, seed 42, with the 4-step ER-SDE
sampler. The numbers are warm runs (the DiT already loaded), the 2nd and 3rd of three
identical generations. Every run was `ok` with no NaN.

| Engine | DiT step | VAE decode | Image |
|---|---|---|---|
| **WKWebView** | **3.9 s** | 1.4–2.4 s | ~17 s |
| **Chrome, default** | **2.2 s** | 0.78 s | ~9.5 s |
| **Chrome, `--enable-unsafe-webgpu`** | **2.2 s** | 0.78 s | ~9.5 s |

- **Chrome is about 1.8× faster, with its default settings.**
- **Subgroup-matrix buys nothing for anima.** The DiT is plain fp16 MatMul and Gemm (394 and
  172 in the 512 graph), with attention written out as MatMul and Softmax, and no
  `MatMulNBits`. ORT evidently does not route that to its subgroup-matrix kernels. No unsafe
  flag is needed to get the gain.
- **The GPU is busy in every engine**, at about 95% during generation, read without sudo from
  `ioreg -r -d 1 -c IOAccelerator` (`"Device Utilization %"`). WebKit is slow because its
  kernels are less efficient, not because the GPU sits idle between them.
- **Against the hardware.** One DiT step is roughly 4.3 TFLOP. That is 2 × ~2.0B parameters ×
  1024 tokens, plus attention, and it is an estimate from the weight size. The M1 Pro GPU
  peaks at about 5.2 TFLOPS, and on M1 fp16 runs no faster than fp32. So WebKit reaches about
  **21%** of peak and Chrome about **37%**. The weights are 3.9 GB against 200 GB/s of memory
  bandwidth, about 20 ms per step, so a step is compute-bound: shader efficiency is the whole
  story.

**Not yet separated.** How much of the 1.8× is `subgroups` itself, and how much is Dawn's
WGSL→Metal codegen against WebKit's, is not known. Disabling subgroups in Chrome would split
the two. Either way the WebKit side has no knob to turn.

---

## Remote compute in the server's Chrome

Under `YAAR_ML_COMPUTE=auto` (the default), a yaar-ml app in the WKWebView window asks the server to run its sessions; the server opens one headless Chrome tab for that app page and relays between them. The app's code is unchanged: `session()`, `run()` and `capabilities()` behave as before, with outputs back as CPU tensors and `capabilities().remote === true`. Design and trust model: [server_env.md](../reference/server_env.md#remote-ml-compute).

Measured 2026-09-29, same M1 Pro, anima 0.4.1, 512×512, seed 42, 4 steps, the app in YAAR's
WKWebView window with `YAAR_ML_COMPUTE=auto`:

| | WKWebView, local | **WKWebView → server Chrome** | Chrome, local |
|---|---|---|---|
| DiT step | 3.9 s | **2.2 s** | 2.2 s |
| VAE decode | 1.4–2.4 s | **0.77 s** | 0.78 s |
| Warm image | ~17 s | **9.6–9.7 s** | 9.6 s |
| DiT load (7 segments, 3.9 GB) | — | **2.6 s** | 5.2 s |

- **The window now generates as fast as Chrome itself**, with the same numerics (no NaN,
  identical latent statistics per step). The relay costs ~0.3 s per image.
- **Weights are read by Chrome, not uploaded.** anima names each DiT segment's slice of the sidecar with `weightRange()`, so the tab fetches it from the server. Uploading the slices as Blobs instead took a 20.5 s load (15.8 s of it uploading 3.9 GB at ~250 MB/s). The 2.6 s is with the file in the OS page cache.
- **Activations stay in the tab.** anima runs its segments with `run(…, { keep })`, so tensors passed between segments never leave Chrome: a warm image moves 60 MB up and 2 MB down, against ~480 MB through the page without `keep` (11.5 s, 2.7 s per step).
- **What does not offload:** code that imports onnxruntime itself (transcribe's Qwen worker)
  rather than going through `session()`/`run()`.

## Options, for later

| Option | Gain for anima | Cost |
|---|---|---|
| **Keep as is** | none; ~17 s per image | none |
| **Compute in a server-side Chrome** — *landed, see above* | ~1.8× | macOS only: Windows (WebView2) and Android WebView are Chromium already, and Linux may stay on Chrome |
| **Native** (MLX, CoreML, ORT's CoreML EP, run by the server) | Above Chrome's ~37% of peak; how far above is unmeasured | A second runtime and model conversion, macOS-only in practice. Each other platform would need its own, and Termux has no usable GPU path |
| **Wait for WebKit subgroups** | Unknown; also depends on how much of the gap is subgroups at all | None, and no timeline |

Measure before choosing. The next useful numbers are Chrome with subgroups off, to split the
gap, and one native DiT step (MLX or PyTorch MPS), to find the ceiling.

## Reproducing

The runs used one dev server with `YAAR_APP_ORIGIN_ISOLATION=0`, so the app iframe is
same-origin with the desktop and the top frame can call the app's own headless hook
(`iframe.contentWindow.__anima.generate(...)`). The same driver ran in both engines:

- **WKWebView:** a bun script calling `runWebviewWindow` from `@yaar/lib/webview`, with the
  driver as its init script and a `__report` binding to hand the result back.
- **Chrome:** a fresh profile with `--remote-debugging-port`, and the driver sent with CDP
  `Runtime.evaluate` (`awaitPromise`).

The driver clicks the app's desktop icon, waits for `__anima.ready`, wraps the iframe's
`console.log` to collect anima's own per-step timings, and generates three times. It is a
throwaway harness; rebuild it from this description rather than looking for it in the tree.
