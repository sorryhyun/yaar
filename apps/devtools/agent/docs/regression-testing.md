---
name: regression-testing
description: Read before a refactor that must not change behavior, or when asked to test an app — previewScript's script format, baselines, and determinism.
audience: agent
---

## Regression testing with `previewScript`

There is no unit-test runner in this environment, and for app work that is usually the wrong
instrument anyway: an app's contract is its protocol, and the change that hurts — a dispatcher
arm dropped in a restructuring, a param spelling silently ignored — is exactly what black-box
replay catches. `previewScript` runs a recorded sequence of protocol commands against the
preview and diffs the results against a baseline **mechanically**, so the comparison lands in
the tool result instead of resting on your own judgment, and the next agent re-runs it with
one call instead of re-driving fifty.

**The baseline is only an oracle when it was captured on a build you trust.** For a refactor
that is the pre-change build: capture first, then touch the code.

## Workflow

1. On the known-good build: `compile`, `preview`, write the script, then `previewScript` —
   with no baseline on disk, this run captures one.
2. Refactor. `compile`, `preview` (a fresh mount — the runner refuses a stale preview).
3. `previewScript` again — `pass: true`, or `failures` naming each row with expected/actual.
4. A failing group re-runs alone: `previewScript` with `groups: ["R7"]`.
5. After an **intended** behavior change, `update: true` rewrites the baseline and reports
   the delta by label — read it; every `changed` entry should be a change you meant to make.

A `previewScript` call runs every step sequentially, so raise its `timeoutMs` well past the
sum of its steps (a 40-step script easily wants 120000+).

## Script format

A JSON file in the project, `src/test/regression.json` by default. Keep it under `src/`:
deploy ships `src/`, `agent/` and the root files, so a suite at a top-level `test/` is
dropped from the deployed app without a word and the next agent to clone it finds nothing.

```json
{
  "baseline": "src/test/baseline.json",
  "round": 4,
  "steps": [
    { "resize": [900, 700] },
    { "command": "newMesh", "params": { "type": "box", "replace": true }, "group": "R2" },
    {
      "command": "meshInfo",
      "pick": ["verts", "tris"],
      "label": "box counts",
      "group": "R2"
    },
    { "state": "scene", "pick": ["meshes.length", "selected"], "label": "scene state" },
    { "eval": "document.querySelectorAll('.layer-row').length", "label": "layer rows" }
  ]
}
```

- `baseline` — where results live. Defaults to `baseline.json` next to the script.
- `round` — decimals kept on every recorded float (per-step `round` overrides). Geometry and
  layout numbers carry float noise; without rounding they fail runs for nothing.
- Each step carries exactly one of:
  - `"command"` + `params` — an app protocol command, like `previewCommand`.
  - `"state"` — a key declared in `defineApp({ state })`, read whole, like `previewQuery`.
    (`{ "type": "state", "key": "…" }` is accepted as the same thing.) Half an app's
    contract is its state, and a `command` row only proves the command answered — pair a
    mutation with the `state` read that is supposed to reflect it.
  - `"eval"` — a JS expression in the preview's global scope, like `previewEval`. The
    fallback for what the other three cannot reach: rendered DOM, and fixture resets.
  - `"resize": [w, h]` — the preview window; setup only, never recorded.
- `label` — how the row is named in the baseline and in failures. Auto-labels embed the step
  index, so an explicit label keeps the baseline readable and survives step insertion better.
- `group` — steps sharing a group re-run together via the `groups` param. Make each group
  self-contained: build its own fixture first (`replace: true`-style), depend on nothing
  before it. Ungrouped steps are global setup and run in every filtered run.
- `pick` — dot-paths into the result (`"saved.verts"`, `"meshes.0.name"`); only these are
  recorded. A path that resolves to nothing records `"<missing>"`, so a field that
  *disappears* fails the row instead of vanishing from the comparison.
- `record: false` — run the step, keep its result out of the baseline. **A step marked this
  way must succeed** (below).
- `timeoutMs` — per step, for a command that legitimately runs long.

## What a failing step does

A **recorded** step that throws records `{ "error": "…" }` as its value and the run continues
— "this now errors" is a comparable finding, and later groups are still worth measuring. When
the step also names `pick` paths, the error is recorded **alongside** them rather than instead
of them: the picks all read `"<missing>"` (the result had no such fields, because there was no
result) and an extra `error` field says why. Without it a thrown step and a step that quietly
stopped returning its fields record the identical row, and the diff's `actual` cannot tell you
which you are looking at.

A step with `record: false` is **setup**, and its failure **aborts the run** with the step's
index, label and error. It has to: its result is by construction absent from the baseline, so
a silently failed fixture leaves every later row measuring state that was never built — and
those rows often still match the baseline, which is worse than no run at all. If a step's
failure is a legitimate thing to observe, drop `record: false` and let it be compared.

## Determinism, or why runs go flaky

Every recorded value must depend on the code alone. The runner sorts keys and rounds floats;
the rest is the script's job:

- **Pin the harness.** Screen-space results (picking, box/lasso selection, layout reads)
  depend on window size and camera — make `resize` the first step and set the camera/view
  explicitly before any step that reads through it.
- **`pick` past the volatile.** Timestamps, ids, byte sizes, durations: project down to the
  fields that are functions of the input, or the baseline fails on every run and trains you
  to ignore it.
- **Build fixtures in-script.** A step that constructs its own geometry/document cannot rot;
  an external file fixture can be deleted or edited out from under the baseline. If one is
  unavoidable, record enough of its identity (counts, not bytes) that drift is attributed to
  the fixture, not the code.
- **Network is not deterministic.** Keep fetch-dependent steps out of the baseline
  (`record: false`) or pick only what the app guarantees about the response.

## When the script itself changed

A `structureMismatch` result means the rows no longer line up with the baseline (steps added,
removed, relabeled) — nothing was value-compared, and `pass` is false. `added` and `removed`
name which rows, matched by label rather than by position, so an insertion in the middle reads
as one addition instead of shifting everything after it.

That is not a wall: verify current behavior on a build you trust, then re-run **the same call**
with `update: true`. Update deliberately does not require alignment — editing the script is the
normal reason to re-capture, and refusing on those grounds would leave nowhere to go. It reports
three lists, and the split is the review:

- `changed` — a row present before and after whose value moved. Each one should be a behavior
  change you intended; this is the list to actually read.
- `added` / `removed` — steps the script gained or lost. Evidence about the script, not about
  the app.

`update: true` still requires a full run: it is refused together with `groups`, because a
partial run cannot stand in for the whole baseline.

## Practical notes

- **Reset a DB-backed app between groups, and watch the filter.** `removeWhere` on
  `yaar://apps/self/db/{table}` **rejects an empty `filter`** rather than reading it as
  "everything" — write `{ "_id": { "$exists": true } }`. Before a failed setup step aborted the
  run, a reset written with `{}` failed on every run and the script quietly measured leftover
  rows from the run before.
- **Prefer a `state` row over an `eval` that reaches into internals.** A state key is the app's
  declared contract and survives a refactor; `document.querySelector` into a class name does
  not, and a rename then reads as a regression.
