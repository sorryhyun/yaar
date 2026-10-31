---
name: debugging
description: Read before hunting a bug with no known location, or probing how an app handles bad input — the order of reads, tracing a cause, probing.
audience: both
---

## Debugging a Running App

### Look, cheapest first

1. **`preview/query`** with no `stateKey`: state, rendered text, console tail and what changed.
   If state is large, `sizes: true` first, then `keys`. State disagreeing with the render is a
   reactivity bug (the `solid-gotchas` topic).
2. **`preview/console`** with `levels: ["error", "warn"]` when the tail was not enough. A broken
   asset shows here as `[resource] failed to load`, and nowhere else.
3. **`preview/eval`** for what no state key exposes: computed styles, element counts, module
   scope through `__debug`. `changed: true` shows what an expression caused.
4. **`preview/faults`** when the bug lives on a failure or loading path, or only at boot.

Screenshots are for visual bugs (the Preview Loop in the prompt); they say little about logic.

### Trace the cause

- `files/grep` for the error text or the wrong value, with `context` to read around each hit.
- `files/findReferences` with `callers` to learn which commands reach a helper.
- `files/typeAt` to read what a value actually is.
- `project/diffInstalled` to see what a clone already changed, and `git/history` for when a
  deployed app changed.
- Reproduce with `preview/command`, then pin the fix in a unit test (the `unit-testing` topic).

### Probe bad inputs

**A few inputs:** `preview/command` with `batch` and `keepGoing: true`. Every step runs, each
failing one carries its `error`, and `failed` counts them. Steps share one app, so a step that
half-applied changes what the next one sees; set the fixture up first.

**Many inputs, or a set to keep:** a `preview/script` file works as a harness (format: the
`regression-testing` topic). A recorded step that throws records `{ error }` and the run
continues. Three things to know:

- The script must be a file in the project. Probes that should not ship go outside `src/`
  (`dbg/probes.json`), since deploy leaves other directories behind.
- With no baseline the run writes one and returns only a summary, so point the script's
  `baseline` at a scratch path (`dbg/probes-out.json`) and read that file for the rows. A second
  run compares against it.
- A step with `record: false` must succeed; its failure aborts the run.

**Before running a script you did not write,** read `build/check`'s `previewEscapes` and grep the
script for `shared/`: only `self` paths stay in preview storage (the `preview-debugging` topic).
