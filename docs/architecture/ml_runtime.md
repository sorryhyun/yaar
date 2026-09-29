# ML Runtime (`@bundled/yaar-ml`)

`@bundled/yaar-ml` lets an app run an ONNX model inside its own iframe, on the browser's WebGPU.
There is no Python, no install and no native runtime. This page explains how that is built: what
the SDK does in the page, what the server serves for it, and the headless Chrome the server can
lend an app whose own engine is slow.

For the app-author API (quick start, what fits, gotchas), see the guide,
[`yaar_ml_runtime.md`](../guides/yaar_ml_runtime.md). The exact semantics of `YAAR_ML_COMPUTE`
are in [`server_env.md`](../reference/server_env.md#remote-ml-compute).

All paths are relative to the repo root.

---

## The idea

A YAAR app is one self-contained HTML file in an iframe. It has no filesystem, no process of its
own, and a CSP that lets it talk only to its own origin. It does have WebGPU, and onnxruntime-web
can run a real model on it. So ML in YAAR is not a service the server runs on the app's behalf.
The model runs in the page, and the platform supplies what a page can't get by itself:

1. **The runtime.** ORT's JavaScript and `.wasm` files, served from the same origin with a
   version on the URL.
2. **The bytes.** Model weights from Hugging Face or a CDN, streamed through a same-origin proxy,
   or pulled onto disk by the server.
3. **Sometimes, a better engine.** On macOS the desktop is a WebKit window, whose WebGPU is
   measurably slower than Chrome's. There the server runs the app's sessions in its own headless
   Chrome, and the app's code doesn't change.

The rule behind all three: **the app sees one API, `session()` / `run()`, and the platform
decides where the bytes come from and where the math happens.**

## The layers

```
 App iframe (app origin, CSP connect-src 'self')
 ┌───────────────────────────────────────────────────────────────┐
 │ app code ── session() / run() / fetchWeights() / weightRange()│
 │                         │                                     │
 │ @bundled/yaar-ml shim (packages/compiler/src/shims/yaar-ml.ts)│
 │   ├─ imports ORT at runtime from /api/ml-runtime/…?v=<ver>    │
 │   ├─ IndexedDB weight cache (4 GB, oldest-first eviction)     │
 │   ├─ local: ORT on a proxy worker, WebGPU EP → wasm fallback  │
 │   └─ remote: RemoteChannel over /api/ml-host/connect ──┐      │
 └──────────────────────────┬─────────────────────────────┼──────┘
                            │ HTTP                        │ WebSocket (binary frames)
 Server (Bun)               ▼                             ▼
 ┌─────────────────────────────────────┐   ┌───────────────────────────────────────┐
 │ http/routes/ml-runtime.ts           │   │ features/ml-host/relay.ts             │
 │  GET  /api/ml-runtime/<file>        │   │  one channel per app socket;          │
 │  GET  /api/ml-weights?url=…  (proxy)│   │  relays frames unread;                │
 │  POST /api/ml-weights/download      │   │  opens one headless tab per channel   │
 │  GET  /api/ml-weights/download?dest │   │  on /api/ml-host/page?ch=<secret>     │
 │ GET /api/storage/… (prefetched file)│   └──────────────────┬────────────────────┘
 └─────────────────────────────────────┘                      │ CDP (lib/browser)
                                                              ▼
                                        ┌───────────────────────────────────────────┐
                                        │ Headless Chrome tab (app origin)          │
                                        │  host-page.client.js: same ORT, same two  │
                                        │  flavors; fetches weights from the server │
                                        │  with the app's token                     │
                                        └───────────────────────────────────────────┘
```

| Layer | What it owns | Where |
|---|---|---|
| **Compiler** | Gating (`"bundles": ["yaar-ml"]`), types, stamping the ORT version into the shim, marking apps stale when ORT moves | `packages/compiler/src/bundled/registry.ts`, `bundled/plugins.ts`, `bundled/ort-version.ts`, `build/build-manifest.ts` |
| **SDK shim** | Loading ORT, the weight cache, session memoization, local and remote execution | `packages/compiler/src/shims/yaar-ml.ts` |
| **Server routes** | Runtime artifacts, the weight proxy, disk prefetch | `packages/server/src/http/routes/ml-runtime.ts` |
| **ML host** (optional) | Pairing an app socket with a Chrome tab, and the tab's script | `packages/server/src/features/ml-host/` |

## Loading the runtime

### ORT is fetched at runtime, not bundled

The shim imports ORT with a type-only import, which is erased, and loads the real module at runtime
from `/api/ml-runtime/ort.webgpu.bundle.min.mjs` through `new Function('u', 'return import(u)')`.
Two things force this:

- **ORT needs a real script URL.** With `env.wasm.proxy` on (see below), ORT starts its worker from
  its own `import.meta.url`. Bundled into the app, that URL is the app's HTML page, and the worker
  would try to parse HTML as a module.
- **The bundler must not see the specifier.** A literal `import(url)` would be resolved at build
  time, and the route isn't a file on disk. The `Function` wrapper is why the app CSP carries
  `'unsafe-eval'` in `script-src` (`packages/server/src/http/csp.ts`). The same CSP's
  `worker-src 'self'` covers ORT's proxy worker.

Because ORT stays out of the bundle, no copy of it ends up in the compiled app. A page downloads
it once, from the route.

### Two flavors, because each covers the other's gap

| Flavor | Module | wasm pair | Used for |
|---|---|---|---|
| **Native WebGPU** | `ort.webgpu.bundle.min.mjs` | `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (~27 MB) | Every session whose providers include `webgpu`. Loaded on import |
| **Full CPU** | `ort.wasm.bundle.min.mjs` | `ort-wasm-simd-threaded.{mjs,wasm}` (~14 MB) | Sessions that resolve to `wasm` alone, including `auto`'s fallback. Loaded on first use |

The package's default export (`.`) would be one artifact for both jobs, but it uses the older JSEP
WebGPU EP. Its buffer allocator miscomputes fp16 graphs that contain single-consumer alias views.
In the anima DiT, the adaLN `Split→Unsqueeze→broadcast` pattern comes back about 10× too large per
block, the residual overflows, and the output is all NaN. That was still true at ORT 1.30. The
`/webgpu` flavor is ORT's C++ (Dawn-based) EP compiled to wasm, and it doesn't share that allocator.

The asyncify build that carries it has a **reduced CPU side**: its float64 kernels are compiled
out. A graph that computes in f64, such as transcribe's mel preprocessor casting the waveform to
double for its STFT, fails with `Could not find an implementation for Cast(13)`. That was measured
on 1.27 and 1.29, so it's a build decision, not a bug in one version. So wasm-only sessions run on
the full CPU build. That build has no WebGPU EP at all, so the JSEP bug can't reach it either.

Tensors cross between the two module instances without trouble. ORT reads
`type`/`data`/`dims`, never `instanceof`, so a `Tensor` from one flavor feeds a session from the
other. The exported `env` is the WebGPU flavor's. The CPU flavor keeps the SDK defaults.

### Serving and versioning

`GET /api/ml-runtime/<file>` serves one artifact by bare file name. The name is `basename()`d and
must match `^[A-Za-z0-9._-]+\.(wasm|mjs|js)$`, so the route can't be walked. It is served with
`Cache-Control: public, max-age=31536000, immutable` and is **exempt from auth**
(`packages/server/src/http/auth.ts`). ORT fetches these files itself and has no hook for a token.
They're inert, publicly published binaries, so a gate would protect nothing and would break ML
under `REMOTE`.

That one-year `immutable` lifetime, combined with file names that don't change between ORT
releases, is a trap. An unversioned URL pins a browser to whichever ORT it fetched first. After the
1.27 → 1.30 bump, the server served 1.30 and the app still ran its cached 1.27 bundle. So **every
runtime URL carries `?v=<ortVersion>`**:

- The compiler stamps `__YAAR_ORT_VERSION__` into the shim from the installed `onnxruntime-web`
  (`ortVersionDefine()` in `packages/compiler/src/bundled/ort-version.ts`). The build manifest also
  records `ortVersion`, so a yaar-ml app goes stale and recompiles when ORT moves.
- `runtimeUrl()` in the shim adds `?v=` to *every* runtime URL, the `.wasm` included. A new
  bundle driving a cached old `.wasm` would be worse than a stale pair. The route reads only the
  pathname, so the query is purely a cache key.
- `wasmPaths` uses the object form (`{ mjs, wasm }`), not a directory prefix, because a prefix
  can't carry a query. That's also why each flavor names its own pair.
- The URLs are absolute. When ORT decides to preload its proxy worker from a `blob:` URL, a
  root-relative specifier has no base to resolve against. That failure was observed on an Android
  phone without WebGPU.

### Where the files come from

`getMlRuntimeArtifact(name)` (`packages/server/src/config/assets.ts`) resolves each file on its
own, in this order:

1. **`YAAR_ML_RUNTIME_DIR`**, when set. It's read on every call, not memoized, so a patched ORT
   can be swapped in without a rebuild.
2. **The copy embedded in the exe.** A standalone binary has no `node_modules`, so
   `scripts/build/exe-bundle.js` embeds exactly the six files in `ML_RUNTIME_ARTIFACTS`
   (~38 MB of the 129 MB `dist/`) through `--asset`. At startup
   `packages/server/src/exe-assets.ts` hands their `/$bunfs/` paths over on
   `globalThis.__YAAR_ML_RUNTIME`.
3. **A directory on disk.** In dev this is the installed `onnxruntime-web/dist`. In an exe it's an
   `ml-runtime/` folder next to the binary, if one exists. That folder only fills in a file missing
   from the embedded set.

`ML_RUNTIME_ARTIFACTS` must list what the shim (and the host page) load. If a file is missing, the
build **fails** instead of shipping a binary whose `/api/ml-runtime/` returns 404. That exact
failure once shipped unnoticed, showing up only as a blank window in every yaar-ml app.

## Getting the weights

A model is tens of MB to several GB, lives on another host, and has to reach a page whose CSP
says `connect-src 'self'`. There are two routes, chosen by how long the bytes should last.

### Streaming proxy + IndexedDB (the default)

`fetchWeights(url)` (and `session(url)`, which calls it) requests
`/api/ml-weights?url=<encoded>`. The route is gated on the app declaring the `yaar-ml` bundle
(`requireBundle`, carried by the app's iframe token in `X-Iframe-Token`). It hands off to the
shared `streamProxy` (`packages/server/src/features/http/stream-proxy.ts`), which enforces
several things for every caller:

- The **SSRF guard** from `@yaar/lib/ssrf`.
- The **domain allowlist.** An unlisted domain opens an "Allow Domain Access" dialog in the
  session and is added to `curl_allowed_domains.yaml` if approved. The request is refused only
  when the user denies it or no session is available to ask.
- A stall timeout.
- A content type that can't run as a document on YAAR's origin.

The body is **piped, never held**. There's no base64 envelope, which is what makes this different
from `/api/fetch`, so hundreds of MB cost nothing extra. The weight route drops the byte ceiling
entirely, because multi-GB files are the point. Bun drops `Content-Length` on a streamed body, so
the declared length travels as `X-Content-Length`, and that's what drives `onProgress`.

The result is stored in IndexedDB (`yaar-ml` → `weights`), keyed by URL, under a 4 GB budget with
oldest-first eviction. Hugging Face `resolve` URLs are pinned to a revision, so the cache treats
them as immutable. `force: true` refreshes one.

### Disk prefetch (bytes that should outlast the browser)

The IndexedDB cache belongs to the browser: clearing site data drops it, and quota pressure evicts
it. A model an app wants to pull once and keep goes to disk instead, and the browser never handles
the bytes. It *couldn't* write them anyway: `POST /api/storage/{path}` buffers the whole body under
`MAX_UPLOAD_SIZE` (50 MB), and anima's DiT sidecar alone is 3.9 GB.

`prefetchWeights([{ url, dest }])` sends `POST /api/ml-weights/download`. The server then:

1. **Checks the destination first.** `dest` is expressed in the permission model's own terms
   (`storageUriFor`) and checked for `invoke`. `apps/self/` resolves to the calling app, and
   read-only mounts are refused. This comes *before* the domain check so the user is never asked
   about a download that would be refused anyway.
2. **Checks the domain** with the same dialog-backed gate.
3. **Streams remote → disk** with `downloadToFile` (`@yaar/lib/download`): eight parallel Range
   chunks (~62 MB/s from the HF CDN, against ~40 MB/s for one stream), resumable from a `.part`
   file, renamed into place only when every chunk has landed.

The job runs detached. The SDK polls `GET /api/ml-weights/download?dest=…` every 500 ms for
`{ state, loaded, total }`. Jobs are keyed by the *resolved* path, so two apps both writing
`apps/self/weights/model.onnx` get separate jobs. A file already on disk reports `done` at once,
which is why calling `prefetchWeights` on every boot is the intended use.

The file is read back through the ordinary `GET /api/storage/…` route (`weightUrl(dest)`), which
serves it straight off disk with `Bun.file`. Bun answers a `Range` header on that with `206`, and
`weightRange` relies on it. The SDK treats same-origin URLs as local: they skip the proxy (whose
SSRF guard would block loopback anyway) and aren't mirrored into IndexedDB, since a second copy of
a multi-GB file would be pure waste.

### Credentials on URLs ORT fetches itself

Sessions run on ORT's proxy worker, which fetches `externalData` URLs itself, with neither of the
credentials a same-origin route needs:

- The **REMOTE token**. An app's own `fetch` passes because the iframe URL, carrying `?token=`,
  goes along as `Referer`.
- The **iframe token**, which app-origin isolation requires on every app-origin request.

The URL is the only channel ORT leaves open. So `authorizeOrtUrl()` puts both tokens in the query
string, same-origin URLs only, on `externalData` entries written in the `{ path, data }` object
form. The bare-string form is left alone: there the one string is both the fetch URL and the
`location` recorded in the `.onnx`, and changing it would break that match.

## The page's own thread

Two constraints shape local execution, and both come from the fact that an app is a page inside
the desktop.

**Single-threaded wasm.** YAAR sends no COOP/COEP, so no page is cross-origin isolated. Without
isolation there's no `SharedArrayBuffer`, and without that there's no multithreaded wasm. The SDK
sets `numThreads = 1`, in both flavors and in the ML host tab. The WebGPU EP doesn't need threads,
so the main path is unaffected. Only the CPU fallback is slow.

**Proxy mode is not optional.** App iframes share the desktop's event loop. `InferenceSession.create`
is one long *synchronous* wasm call: parsing the graph, copying external data into the heap, and
uploading weights to the GPU. Awaiting it doesn't yield. On the calling thread, a multi-GB load
would freeze the taskbar and every other window. So `env.wasm.proxy = true` runs sessions on ORT's
worker, at two known costs the SDK absorbs:

- **Inputs are transferred.** `run()` hands ORT a copy of each CPU feed (`copyFeeds`), so a buffer
  reused across diffusion steps doesn't turn up detached on the second step.
- **The model buffer is detached.** Each creation attempt gets its own `bytes.slice()`, so the
  wasm fallback doesn't receive an empty model.

Proxy mode rules out `preferredOutputLocation` and GPU-resident inputs, and the SDK uses neither.

## Remote compute: the server's Chrome

### Why

On macOS the desktop is YAAR's own WKWebView window. On the same M1 Pro, anima's DiT step takes
**3.9 s in WebKit and 2.2 s in Chrome** (about 1.8×), with the GPU ~95% busy in both. WebKit's
kernels are just less efficient. WebKit has no `subgroups` and no switch that adds them, so no
setting in the window can close the gap (measurements: [`mac_ml.md`](../installations/mac_ml.md)).
The server already drives a headless Chrome for the Browser app, so the model can run there: the
same ORT and the same app code, on a different engine.

### Who decides

The page doesn't read `YAAR_ML_COMPUTE`. It asks. On the first `capabilities()` or `session()`,
the shim opens `/api/ml-host/connect` with its iframe token, `engine=<webkit|chromium|other>`
(sniffed from the user agent) and `v=<ortVersion>`. The server authenticates it
(`requireBundledApp(…, 'yaar-ml')`) and applies `wantsRemoteCompute(engine)`:

| `YAAR_ML_COMPUTE` | Offloads when |
|---|---|
| `auto` (default) | The server is on macOS **and** the page reports `webkit`. That pair is the measured gap. A Chromium page gains nothing from a second Chromium, and Windows (WebView2) and Android WebView are already Chromium |
| `chrome` | Always, whatever the page runs in. Useful for benchmarks |
| `local` | Never |

The answer is the first message on the socket. `{op:'local', reason}` means "compute here", and
the shim logs `[yaar-ml] computing in this page: <reason>`. `{op:'ready', caps}` means the tab is
up, and `capabilities()` then describes *its* adapter with `remote: true`. Any failure also means
"compute here": no Chrome, an old server, a tab that doesn't come up (the server gives it 60 s,
the page waits 90 s), or ORT failing to load in the tab. The fallback is silent and complete.

### How the relay pairs

For each accepted app socket, `relay.ts`:

1. Creates a **channel** with a random id and a 24-byte **secret**.
2. Opens a headless browser session named `ml-host-<id>` and marks it `pinned`. The idle sweep
   can't see socket traffic and would otherwise decide nobody was using the tab.
3. Navigates it to `/api/ml-host/page?ch=<secret>`, **on the app origin**. The page inlines
   `host-page.client.js` under a nonce, with a config holding the ORT runtime URLs (same `?v=`),
   the app's iframe token, the REMOTE token if any, and the host-side socket URL.
4. The tab loads the WebGPU flavor (the CPU flavor on first use, as in the shim), reads its
   adapter's capabilities, then dials `/api/ml-host/ws?ch=<secret>`.
   From then on the relay **forwards binary frames between the two sockets without reading them.**
   The only frames it writes itself are `local` and `gone`.

**One tab per app socket** is what ties GPU memory to the app's lifetime without any bookkeeping.
When the iframe goes away, its socket closes, the relay closes the tab, and Chrome frees every
session in it. A second host socket on the same channel means the tab reloaded (a renderer crash
replayed by the browser layer). Its sessions are gone while the app still holds them, so the
channel ends with `gone` rather than pretending otherwise. A `send()` that Bun reports as dropped
(backpressure past its limit) also ends the channel, because one lost fragment would corrupt every
message after it.

**Trust.** The tab *is* the app, not the host. It carries only the app's iframe token, and
`authorize()` in the host page *forces* that token (and the REMOTE token) onto every same-server
URL it fetches, even one the app named with some other token. Its CSP is no wider than an app's.
It can reach exactly what the app could. The page and host socket are keyed by the channel secret,
which the app never sees.

On Linux, WebGPU in headless Chrome needs Vulkan flags. The headless pool adds
`LINUX_WEBGPU_FLAGS_HEADLESS` (`packages/server/src/lib/browser/webgpu-flags.ts`). The ML host
inherits them like any other tab, which matters only under `YAAR_ML_COMPUTE=chrome` on Linux.

### What crosses the wire

The shim (`RemoteChannel`) and the host page each keep a copy of the wire format, which must be
kept in step:

```
frame   = [u8 more][fragment]                          ≤ 4 MB; more=1 while fragments follow
message = [u32 LE headerLen][u32 0][header JSON pad8][buf pad8]…   header.b = buffer lengths
```

Padding to 8 keeps each buffer aligned in the reassembled message, so the receiver can view a
tensor as a typed array without copying. Fragments of one message are sent back to back with no
`await` between them, so two messages never interleave.

| Op | Page → tab | Tab → page |
|---|---|---|
| `blob` | A 4 MB chunk of `externalData` the app holds as bytes, at most 3 unanswered (Bun drops frames past 16 MB unsent per socket) | ack |
| `create` | The `.onnx` graph bytes, options, and the `ext` list: each entry a URL, a `range`, or a `blob` id | input/output names |
| `run` | Feeds as bytes, or as a `ref` to a kept tensor; `keep` names | Outputs as bytes, or `ref`s for kept ones; ORT's own run time `ms` |
| `fetch` | A `ref` | That tensor's bytes (`getData()`) |
| `drop` | `ref`s the app disposed or garbage-collected (batched per tick through a `FinalizationRegistry`) | ack |
| `release` | A session id | ack |

`blob` and `drop` are handled immediately. Everything else runs one at a time in the order sent.
In the tab, `proxy` is **off**: nothing else lives on that page, so a blocking `create` freezes
nobody and the worker hop would only add copies. The `.onnx` graph itself always comes from the
page (through `fetchWeights`, so from the IndexedDB cache) and crosses once. That's cheap because
a large model keeps its weights in `externalData`.

### Where the time goes, and the two APIs that avoid it

Offloading is only a win if bytes don't bounce through the page.

- **Weights: name them, don't send them.** An `externalData` entry given as a URL is fetched by
  the tab straight from the server (`remoteUrl` turns same-origin URLs into paths the tab
  authorizes). `weightRange(url, start, end)` does the same for a *slice* of a file. The tab
  requests `Range: bytes=…`, the server answers `206` off disk, and in the page the SDK makes the
  identical request itself. Bytes the app fetched on its own can only be uploaded as `blob`s. For
  anima, uploading the 3.9 GB sidecar that way took 15.8 s of a 20.5 s DiT load. Named as ranges,
  the load takes 2.6 s.
- **Activations: keep them.** `run(s, feeds, { keep: ['h'] })` leaves the named outputs in the tab
  and returns `RemoteTensor` handles (`location: 'remote'`). A handle fed to the next run crosses
  as its id. Its `.data` throws, `await getData()` fetches it, and `dispose()` frees it (as does
  GC). Locally, `keep` is ignored and outputs are ordinary tensors, which have the same
  `getData()`/`dispose()`, so code written against that surface runs the same either way. anima
  runs its DiT as 7 segments per step. Before `keep`, a warm image moved ~480 MB of activations
  through the page. With it, 60 MB up and 2 MB down.

Everything else crosses as plain CPU tensors, and outputs come back as ordinary `ort.Tensor`s.
String tensors can't cross. The page exposes running totals on `globalThis.__yaarMlRemoteStats`
for measuring what the relay costs. With both APIs in use, the window generates at Chrome's speed,
with ~0.3 s of relay cost per image ([`mac_ml.md`](../installations/mac_ml.md#remote-compute-in-the-servers-chrome)).

### What stays local

- **Raw `ort` use.** A worker that imports onnxruntime itself (transcribe's Qwen worker, for
  example) never goes through `session()`/`run()`, so nothing redirects it. The exported `ort`,
  `env` and `Tensor` are the page's own.
- **The weight cache and prefetch.** IndexedDB lives in the page, and prefetch is a server job
  either way. Only the tab's *reads* of named weights move.
- **Sessions from a dead channel.** When the channel ends, pending requests reject, and memoized
  sessions tied to it are dropped. The next `session()` reconnects, to a new tab or to local
  compute if the server now declines.

## Key files

| File | Role |
|---|---|
| `packages/compiler/src/shims/yaar-ml.ts` | The SDK: ORT loading and flavors, `?v=` URLs, weight cache, prefetch client, session memo, local execution, `RemoteChannel`/`RemoteSession`/`RemoteTensor` |
| `packages/compiler/src/bundled-types/index.d.ts` | `declare module '@bundled/yaar-ml'`: the types apps compile against |
| `packages/compiler/src/bundled/registry.ts` | `yaar-ml` in `BUNDLED_LIBRARIES`; `yaar-*` names form `GATED_BUNDLED_LIBRARIES` |
| `packages/compiler/src/bundled/plugins.ts` | Refuses `@bundled/yaar-ml` unless `app.json` declares the bundle |
| `packages/compiler/src/bundled/ort-version.ts` | Reads the installed ORT version; `define` stamps it into the shim |
| `packages/compiler/src/build/build-manifest.ts` | Records `ortVersion`; an ORT bump makes yaar-ml apps stale |
| `packages/server/src/http/routes/ml-runtime.ts` | `/api/ml-runtime/`, `/api/ml-weights`, `/api/ml-weights/download` |
| `packages/server/src/features/http/stream-proxy.ts` | Shared streaming proxy: SSRF, allowlist, stall timeout, safe content type |
| `packages/server/src/features/http/domain-gate.ts` | The allowlist check that asks the user before refusing |
| `packages/server/src/config/assets.ts` | `getMlRuntimeArtifact` / `getMlRuntimeDir`: override → embedded → on disk |
| `packages/server/src/exe-assets.ts` | Publishes the embedded artifacts on `globalThis.__YAAR_ML_RUNTIME` |
| `scripts/build/exe-bundle.js` | `ML_RUNTIME_ARTIFACTS`: the six files the exe embeds; fails the build if any is missing |
| `packages/server/src/http/auth.ts` | Exempts `/api/ml-runtime/` (and only that prefix) from the REMOTE gate |
| `packages/server/src/http/csp.ts` | App CSP: `'unsafe-eval'` for the runtime import, `worker-src 'self'` for ORT's proxy worker |
| `packages/server/src/features/ml-host/relay.ts` | `YAAR_ML_COMPUTE`, channel pairing, the host page's HTML and CSP, teardown |
| `packages/server/src/features/ml-host/host-page.client.js` | Browser script in the headless tab: ORT, `create`/`run`/`fetch`/`drop`/`release`, forced app credentials |
| `packages/server/src/websocket/server.ts` | Routes `ml-client` / `ml-host` sockets to the relay |
| `packages/server/src/lib/browser/webgpu-flags.ts` | Linux Chrome flags that make WebGPU available (headless set) |
| `packages/server/src/tests/ml-runtime-artifact.test.ts`, `ml-host-relay.test.ts`, `ml-weights-dest.test.ts`, `packages/tests/src/integration/ml-runtime-remote-auth.test.ts` | Tests for artifact resolution, the relay, prefetch destinations, and runtime auth under REMOTE |
| [`docs/guides/yaar_ml_runtime.md`](../guides/yaar_ml_runtime.md) | App-author guide |
| [`docs/installations/mac_ml.md`](../installations/mac_ml.md) | WebKit vs Chrome measurements that motivate remote compute |
