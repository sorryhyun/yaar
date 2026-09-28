---
name: command-design
description: Read before designing commands an agent calls with ids, batches, open params, big collections, or a picture to return — shapes that fail loudly.
audience: agent
---

## Command Design (patterns from shipped apps)

An agent cannot see the screen the way a person does, so every silent success is a lie
it will build on. Each pattern below turns one silent failure into a named, retryable
error. `Seen in` names an installed app — `cloneApp` it for the full code.

### Return pictures as content blocks, never as a data-URL field

A command whose `run` returns a **bare array** of `{ type: 'text', text }` /
`{ type: 'image', data, mimeType }` blocks reaches the caller as real image content —
the same path `readFile` uses. Wrap the same bytes in an object (`{ image: dataUrl }`)
and it is JSON-stringified: the agent gets a few hundred thousand characters of base64
it cannot see, and nothing errors. Put measurements in a text block beside the image so
they stay greppable. *Seen in:* mesh-edit `src/protocol/shared.ts` (`captureBlocks`),
dc-comics `src/services/ai/blocks.ts`.

### Ids a later edit can renumber: take `expectVersion`

If a read hands out indices or ids that a mutation can invalidate, bump a counter once
per mutating call, return it on every read, and accept `expectVersion` on writes. A
mismatch throws **before anything runs**, naming both numbers and saying "re-read and
retry; nothing was applied". Stale-id writes become an error instead of corruption.

```ts
if (p.expectVersion !== undefined && p.expectVersion !== doc.version)
  throw new AppCommandError(`expectVersion ${p.expectVersion} ≠ current ${doc.version}. ` +
    'Re-read and retry; nothing was applied.');
```

*Seen in:* mesh-edit `src/store/ops/run.ts`. The cheaper cousin when ids cannot exist
(an embed inside Markdown has nowhere to hold one): address by position and say in the
description that **inserting or deleting renumbers everything after it** — re-read
between edits, or edit back to front. *Seen in:* word-excel `agent/docs/embeds.md`.

### Batches: atomic by default, and say exactly what state you left

A "run N ops" command snapshots before the first op and restores on a throw. The error
names the 1-indexed step, the op, the reason, and either "nothing was applied" or (non-
atomic) how many ops *did* commit. Without that sentence the caller must re-derive the
document to know where it stands. *Seen in:* mesh-edit `src/store/ops/run.ts`.

### Open params bags: reject unknown keys and list the valid ones

Zod rejects unknown **top-level** keys; it does not reach a nested map whose valid keys
depend on a sibling (`params` per primitive `type`), nor a `looseObject` per-op spec.
There, an accepted-but-unread key is a typo reported as success. Two proven fixes:

- A per-context validator that throws naming the bad key **and every valid key** for that
  context (studio-3d `src/primitives.ts`, `validateParams`).
- When reads happen through helpers a lint cannot follow, wrap the spec in a `Proxy`
  that records which keys the handler read, and reject any caller key nothing read
  (mesh-edit `src/store/ops/validate.ts`, `watchReads`).

```ts
const read = new Set<string>();
const spec = new Proxy(o, { get: (t, k) => (typeof k === 'string' && read.add(k), Reflect.get(t, k)) });
runOp(spec);
const ignored = Object.keys(o).filter((k) => !read.has(k));
if (ignored.length) throw new AppCommandError(`unused keys: ${ignored.join(', ')}`);
```

### Big collections: capped listing vs paged read — pick by write-back

- **Capped** (prefix + `total` + `truncated`, no way to the rest) is for the caller's
  eyes only — safe when nothing writes the listing back.
- **Paged** (`offset` → `nextOffset`) is mandatory when the result may be edited and
  written back: a write built from a truncated read silently deletes the tail.

*Seen in:* mesh-edit `agent/docs/caps-and-budgets.md`.

### One flag per kind of "incomplete"

A single `truncated: boolean` lets an agent read a partial result as a complete
negative. Keep sources apart — `apiTruncated` (upstream cut it) vs `cappedByApp` (our
limit), `binary` vs `truncated`, `scanned` vs `candidates`, `rateLimited` — and put a
prose `note` in the result telling the caller not to conclude "no matches" from it.
When an external index answers `0`, it may mean "not indexed": spend one control query
on an identifier you know exists before reporting absence. *Seen in:* github
`src/code.ts` (`probeIndexCoverage`).

### Verbs that never overlap, and one coordinate space

- Split an overloaded verb by effect: image-edit's `crop` (removes source pixels),
  `resize` (rescales artwork), `canvas` (sets the output frame) — each resets with a
  bare call, and a result flag (`fittedToCanvas`) tells the caller it probably called
  the wrong one.
- Every coordinate param lives in **one fixed space** (image-edit: original-bitmap
  pixels) regardless of zoom, rotation or crop, and the description says so. The UI's
  pointer path inverts view transforms for humans; callers get no such conversion, and
  an off-frame rect is drawn, not rejected. *Seen in:* image-edit
  `agent/docs/coordinate-space.md`.

### Batches of independent items: continue and report

Atomic rollback is for one document. For N independent items (install N apps, fetch N
pages), a failure on one must not abort the rest — record it in a per-item `results` array
and move on, or the remainder stays stale with nothing on screen saying so. *Seen in:*
market-apps `src/actions/update-all.ts`.

### Busy guards: check before mutating, lock synchronously

- **Refuse before touching anything.** crawl's search commands wrote filters and switched
  tabs *before* their busy check, so a refused call still changed settings.
- **The lock is a plain module flag set before the first `await`**, not the signal the UI
  displays: market-apps' `updateRun` is raised several awaits in, so two quick calls both
  saw it down. Its `runInFlight` flag is the lock; the signal is for display.

### Replay is a per-command question

`replay: 'never'` is decided by *"does re-running this on remount duplicate or wrong an
effect?"*, not by category: a read that re-shows a file replays harmlessly, while its
sibling `storage:write` must not. Undo, redo, play, "reload textures" and anything that
starts a job are `'never'` too.
