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
   which rows moved — read that list; every entry should be a change you meant to make.

A `previewScript` call runs every step sequentially, so raise its `timeoutMs` well past the
sum of its steps (a 40-step script easily wants 120000+).

## Script format

A JSON file in the project, `test/regression.json` by default:

```json
{
  "baseline": "test/baseline.json",
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
    { "eval": "document.querySelectorAll('.layer-row').length", "label": "layer rows" }
  ]
}
```

- `baseline` — where results live. Defaults to `baseline.json` next to the script.
- `round` — decimals kept on every recorded float (per-step `round` overrides). Geometry and
  layout numbers carry float noise; without rounding they fail runs for nothing.
- Each step carries exactly one of:
  - `"command"` + `params` — an app protocol command, like `previewCommand`.
  - `"eval"` — a JS expression in the preview's global scope, like `previewEval`.
  - `"resize": [w, h]` — the preview window; setup only, never recorded.
- `label` — how the row is named in the baseline and in failures. Auto-labels embed the step
  index, so an explicit label keeps the baseline readable and survives step insertion better.
- `group` — steps sharing a group re-run together via the `groups` param. Make each group
  self-contained: build its own fixture first (`replace: true`-style), depend on nothing
  before it. Ungrouped steps are global setup and run in every filtered run.
- `pick` — dot-paths into the result (`"saved.verts"`, `"meshes.0.name"`); only these are
  recorded. A path that resolves to nothing records `"<missing>"`, so a field that
  *disappears* fails the row instead of vanishing from the comparison.
- `record: false` — run the step, keep its result out of the baseline.
- `timeoutMs` — per step, for a command that legitimately runs long.

A step that throws records `{ "error": "…" }` as its value and the run continues — "this now
errors" is a comparable finding, and later groups are still worth measuring.

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

A `structureMismatch` result means the script itself drifted from the baseline (steps added,
removed, relabeled) — nothing was value-compared. Re-capture with `update: true`, on a build
whose behavior you have verified.
