# Lab — notes for whoever edits this next

A cell-based notebook. JS runs in a Web Worker; the UI and the agent protocol both talk to
that worker through one queue. The design constraint that shapes everything: **large data
must never cross the protocol boundary.** `runCode` returns a byte-capped summary, cell
outputs are capped again before they are written to disk, and `state.currentNotebook`
excludes outputs entirely. If you add a command, keep that property.

## Layout

```
src/kernel-source.ts   the worker, as a String.raw template  <- read the warnings below
src/kernel.ts          main-thread worker lifecycle: queue, timeout, terminate, restart
src/bridge.ts          dispatch for calls the worker makes back into the app (store/http/chart)
src/store.ts           notebook signals + persistence in appStorage
src/run.ts             cell execution orchestration, lastRun, run summaries
src/chart.ts           kernel chart spec -> Chart.js config; offscreen PNG rendering
src/media.ts           data URL -> blob, saving into the shared media tree
src/App.ts             the notebook UI
src/output.ts          output part dispatch (+ chart/image blocks)
src/json-view.ts       collapsible JSON tree
src/table-view.ts      sortable, paginated table
src/protocol.ts        state + execution commands
src/protocol-nb.ts     notebook/cell/export commands
```

## src/kernel-source.ts — the sharp edges

The worker cannot be a separate bundle: the compiler inlines everything into one HTML file,
so there is no second entry point to load. The kernel is therefore a **string**, turned into
a Blob URL at runtime. Consequences:

- It is `String.raw` so backslashes survive (regexes work). That means **no backticks and no
  `$` followed by `{` anywhere in the kernel body** — either one ends or interpolates the
  template. Use string concatenation, and `String.fromCharCode(96)` where the scanner needs
  to compare against a backtick.
- It is **not type checked**. A typo there compiles fine and fails at run time. Test kernel
  changes with `previewCommand runCode`, not with `compile`.
- Internals are prefixed `__lab` so a user's `var logs = ...` cannot shadow them. Only
  `store csv df stats plot http show md sleep` are meant to be visible.

### Why the source transform exists

Cells need three things at once that plain `eval` cannot give together: shared variables
across cells, top-level `await`, and a REPL-style last-expression value. `__labTransform`
gets all three:

1. `__labScan` walks the source once, recording brace depth and which characters are code
   (not string/template/comment/regex). Regex-vs-division is guessed from the preceding
   token; it is a heuristic, and it only ever costs a missed hoist.
2. `__labHoist` rewrites **top-level** declarations so they land on `globalThis`:
   `const x = 1` -> `x = 1` (implicit global — the body must stay sloppy-mode, so never add
   `'use strict'`), `const {a} = o` -> `;({a} = o)`, and `function f`/`class C` are left
   alone with `globalThis.f = f` appended. Declarations at depth > 0 are untouched.
3. `__labSplitTail` finds the latest split where the head compiles as statements and the
   tail compiles as an expression; the tail becomes `return (tail)`. It **refuses a tail
   that starts with `function`/`async function`/`class`**, and that refusal is
   load-bearing: such a tail compiles as an expression, but a named function
   *expression* binds its name only inside itself, so stage 2's `globalThis.f = f` —
   emitted ahead of the `return` — throws ReferenceError into its own `catch` and the
   declaration is silently lost. A cell containing only a helper definition is the
   common case, so it regressed exactly where it hurt most.

Every stage verifies itself with `new AsyncFunction(...)` and falls back to the untransformed
source, so a scanner bug degrades to "variables did not persist", never to a crash. When
changing this, re-test the declaration forms in one cell and read them back in the next:
object and array destructuring, `class`, arrow `const`, `var`, and `let` with no initializer.
Test each form **as the cell's last statement too** — the split in stage 3 only reaches the
trailing one, so `function f(){}` alone in a cell and `function f(){}` followed by anything
take different paths.

### Cancellation

There is no soft interrupt for a runaway `while (true)`. Timeout and Cancel both
`worker.terminate()`, which is why both report that the scope was wiped. Do not try to make
them preserve state.

## Two truncation layers, do not confuse them

- `__labEncode` — for the **UI**: generous caps (5 000 table rows, 250 KB JSON).
- `__labAgentResult` — for **`runCode`**: a byte budget (`resultLimit`, default 8 KB) that
  fills a row sample until the budget runs out and reports `shape` + `truncated`.
- `trimOutput` in `src/store.ts` — a third pass before a notebook is written to disk
  (200 rows/part, images over 400 KB dropped), so a notebook file cannot grow unbounded.

`saveResultTo` is handled **inside the worker**, before encoding, so the full value is written
from the sandbox and only a path comes back.

## Chart.js

Never write an explicit `undefined` into a Chart.js options object. A present-but-undefined
`scales.x.type` made Chart.js fall back to a linear axis and render category labels as
0,1,2,3. `buildConfig` now always names a concrete `type`. Horizontal bars swap which axis
carries the categories — that is what the `o.horizontal` branch in `buildConfig` is for.

PNG export renders a second, offscreen chart at `scale` device pixels rather than reading the
live canvas, so exports are crisp and independent of the on-screen size. The background fill
is a tiny plugin using `destination-over`, because a bare canvas exports transparent.

## UI

- `Index`, not `For`, over cells: every edit produces new cell objects, so `For` (keyed by
  reference) would tear down the focused textarea on each keystroke.
- Textarea value is **not** reactively bound. A `createEffect` writes it only when it differs
  from the DOM, which keeps the cursor put while still picking up agent-side edits. That
  effect is also where the first `autosize` happens — `scrollHeight` reads 0 in a `ref`
  callback, since the node is not in the document yet.
- Layout is absolute positioning throughout, not flex chains, because Solid's `html` inserts
  comment markers into reactive slots and breaks `flex: 1`.
- `previewScreenshot` in devtools does not render textarea heights or scroll position
  faithfully. Verify layout with `previewEval` measurements, and verify charts by exporting
  a PNG and reading it back.

## Storage layout

```
notebooks/index.json     [{ id, title, updatedAt, cellCount }]
notebooks/{id}.json      the notebook, outputs included but trimmed
state.json               { lastOpened }
```

The index is derived data; if it ever disagrees with the files, it is the index that is wrong.

## Not done (V2)

Python. Pyodide is not in the bundle list, so it would need a new bundle — ask before
starting. If it lands, it should be a second kernel behind the same `runCode` contract, with
a `language` param, rather than a second app.
