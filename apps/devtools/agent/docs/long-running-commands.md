---
name: long-running-commands
description: Read before writing a command that can outlive a tool timeout (crawl, batch render, model load, big download) or a progress/status state key.
audience: agent
---

## Long-Running Commands

Four apps (crawl, dc-comics, anima, transcribe) converged on the same shape
independently. A command that may run for minutes must not make the caller wait on it:
the caller's timeout fires first and reads as failure.

### Start, then poll or subscribe

- `run` starts the job and returns at once: `{ started: true, jobId, poll: 'status' }`.
  Declare `replay: 'never'` — a remount must not start a second job.
- A **state key** (`status`, `crawlProgress`, `lastBatch`) is what the caller polls; it
  updates as the job advances, not only at the end. For a push instead of a poll, emit a
  completion event the caller can subscribe to **before** starting (anima's
  `batchComplete`).
- The command's description says the results are *not* in the reply. anima's hint
  spells out "don't tell the user results are ready off the start acknowledgement" —
  without it the monitor agent does exactly that.

### One job slot, one busy check

A second start while one runs is an error (`Busy: crawl already running`), not a
queue. The UI button and the agent command go through **the same** check, or a
click and a command can double-run the job.

### Progress that does not flood subscribers

A native progress callback (fetch, ORT's `onProg`, a decoder) fires hundreds of times a
second; each signal write is a state event that wakes every subscribed agent. Dedupe
against the **live signal**, not a local copy, so an external reset (`setProgress(null)`)
still invalidates the dedupe:

```ts
function pushProgress(label: string, pct: number) {
  const cur = progress();
  const rounded = Math.floor(pct);
  if (cur && cur.label === label && cur.pct === rounded) return;
  setProgress({ label, pct: rounded });
}
```

*Seen in:* anima `src/app/logging.ts`.

### What a status line may say

- `status`/`progress` carry **phase + counter** for a person watching
  (`"Denoising 2/4"`). Numeric internals (σ, tensor min/max, per-chunk timings) go to the
  console and a `result.steps`-style field on the last-result key, behind an opt-in
  verbose flag.
- Two independent lifecycles (model load and media fetch) stay **two signals** and merge
  in exactly one place — the state getter. The merged label then hides one of them, so
  also expose the fact callers actually decide on as its own field (transcribe's
  `modelsMissing` beside `phase`). Never make a merged display string load-bearing.

### Refuse before the expensive part

Check what makes the job impossible **before** spending a multi-GB download or a
100-request sweep on it — transcribe calls `capabilities()` from `@bundled/yaar-ml` and
throws "enable hardware acceleration" before any weights move.

### Driving one from devtools

If you must wait inside a single call, raise `timeoutMs` to the job's real budget
(dc-comics' prompt asks for 600000) — or better, poll the state key between turns.
