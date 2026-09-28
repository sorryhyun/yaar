---
name: ml-inference
description: Read before building on @bundled/yaar-ml or WebGPU — capability checks, session-create wedge, big weights, workers' hidden console, headless hooks.
audience: agent
---

## In-Browser ML (anima, transcribe, ocr)

### Check capability before the download

Call `capabilities()` from `@bundled/yaar-ml` first and throw a person-actionable message
("enable hardware acceleration, Chrome 113+, and reload") before any weights move. A
WebGPU-only model that downloads 2GB and then fails inside a worker at session-create
is the worst order. *Seen in:* transcribe `src/engine/runtime.ts` (`requireWebGpu`).

### One failed WebGPU session-create wedges the page

ORT's WebGPU EP allows one session-create in flight and clears its in-progress handle
only on success. Any throw mid-create (a 403 on a weights sidecar) leaves it set; every
later create fails with *"another WebGPU EP inference session is being created"* until
the page reloads, and there is no API to clear it. So:

- funnel every session creation through **one serialized queue**;
- match that message, latch a `RuntimeWedgedError`, and surface it once in `state:`
  ("reload required") instead of rediscovering it per call;
- read a burst of instant failures 50ms apart after a wedge as the wedge, not as
  unawaited concurrency.

*Seen in:* anima `src/ml/runtime.ts` (`WEDGE_RE`, `createSessionSerialized`).

### Multi-GB weights on a phone: segment by byte range

One session over a 3.9GB sidecar holds the file in memory *while* filling as much GPU
memory — on a phone both come from the same RAM, and the tab is killed. anima splits the
graph into segments that each name byte ranges of one shared sidecar, and Range-fetches
only those ranges as Blobs (passed to ORT's worker by reference). Several variants share
one sidecar at a few MB of graph each. Probe sizes with a 1-byte Range GET
(`external-fetch` topic). *Seen in:* anima `src/ml/downloadWeights.ts`.

### A worker's console reaches nobody

`console.*` inside a Worker is invisible to `consoleLogs`, the page, and every capture.
Have the worker `postMessage` a `{ type: 'log' }` and re-emit it with `console.info` on
the page side. And report *which model build ran* from a value the worker derived at
init, never from one echoed back from the request — an echo reports the requested
variant as the one that ran. *Seen in:* transcribe `src/engine/qwen/engine.ts`,
`worker-source.ts`.

### Protocol params stay JSON Schema

`@bundled/yaar-ml` resolves its runtime with a top-level `await import('/api/ml-runtime/…')`,
which cannot run where the compiler folds a Zod schema — the same failure as a
module-scope `` html`` `` (`verb-api` topic), and it takes the whole manifest with it.
All three ML apps use JSON Schema literals for every param.

### A headless hook beside the protocol

anima, ocr and transcribe each expose `window.__<app>` with raw pipeline stages (probe,
download, single forward pass, adapter info) for numerics and plumbing checks driven over
CDP or `previewEval`. It is deliberately **not** the agent protocol: protocol commands
serve a user's request; the hook verifies that stage N compiles and produces sane
numbers. Keep internals (σ, tensor stats) there and in the console, not in the status
line (`long-running-commands` topic).
