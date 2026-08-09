# Lab — notes for whoever edits this next

A cell-based notebook. JS runs in a Web Worker; the UI and the agent protocol both talk to
that worker through one queue. The design constraint that shapes everything: **large data
must never cross the protocol boundary.** `runCode` returns a byte-capped summary, cell
outputs are capped again before they are written to disk, and `state.currentNotebook`
excludes outputs entirely. If you add a command, keep that property.

## Layout

```
src/main.ts            defineApp: state, commands, view, onClose
src/types.ts           every shared type (Cell, Notebook, OutputPart, ChartSpec, RunResult)

src/kernel/
  source/              the worker source, split into 11 String.raw parts <- read the warnings below
  source.ts            joins the parts into KERNEL_SRC (order is load-bearing)
  worker.ts            main-thread lifecycle: queue, timeout, terminate, restart
  bridge.ts            dispatch for calls the worker makes back into the app
  paths.ts             store path rules (app-private by default vs. explicit yaar:// URIs)
  store-ops.ts         the five store operations behind the bridge

src/state/
  signals.ts           the signals everything else reads; uid(); flashCellFor()
  agent-runs.ts        the Agent runs log + which main view is showing
  persistence.ts       appStorage layout, autosave, open/new/delete, bootstrap
  cells.ts             every mutation of the open notebook's cells
  run.ts               cell execution orchestration, lastRun, timeout setting, RunOrigin
  starter.ts           the cells a new notebook opens with

src/lib/               no app state, no DOM ownership; safe to call from anywhere
  chart-config.ts      kernel chart spec -> Chart.js config
  chart-render.ts      live canvas + offscreen PNG rendering
  media.ts             media/lab path rules, saving a data URL to the shared tree
  data-url.ts          data URL <-> blob, browser download
  markdown.ts          marked + sanitizeHtml
  summarize.ts         a run result -> the one line the agent reads
  trim.ts              the on-disk output cap (see the truncation layers below)

src/components/        App shell, Sidebar, CellRow, CellEditor, OutputView,
                       ChartView, ImageView, JsonView, TableView, AgentPanel,
                       editor-registry.ts (textarea map + edit-mode signals)

src/protocol/          state.ts, run.ts, notebook.ts, export.ts, shape.ts
src/styles/            one sheet per area, imported in cascade order by main.ts
```

Three conventions worth keeping:

- **No `index.ts` anywhere.** Every import names a real file, so a path in a stack
  trace is the file you open.
- **Dependencies point one way:** components -> state -> kernel/lib. `lib/` imports
  nothing from `state/` or `components/`, which is what keeps it testable from a cell.
- **`main.ts` spreads the command maps directly** (`{ ...runCommands, ... }`) rather
  than through a re-export barrel: the manifest extractor needs statically readable
  object literals, so keep descriptor maps as plain `const` objects and spreads.
  Verify any reshuffle with devtools' `manifest` command — a pure move must not
  change the command or state list.
- **`src/styles/` import order is the cascade.** main.ts lists the sheets in the order
  they must apply; reordering the imports reorders the rules.

## src/kernel/source/ — the sharp edges

The worker cannot be a separate bundle: the compiler inlines everything into one HTML file,
so there is no second entry point to load. The kernel is therefore a **string**, turned into
a Blob URL at runtime. Consequences:

It is split across `src/kernel/source/*.ts` as 11 exported parts that `source.ts`
concatenates with `join('')`. The split is byte-exact and must stay that way:
**each part after the first begins with the newline that follows its opening backtick,
and that newline is the blank separator line between sections.** So a part starts at
its section banner and ends at its last non-blank line — add a stray blank line at
either end and every line number in a kernel stack trace shifts. When you change the
boundaries, prove it: keep a copy of the old source, `console.log(NEW === OLD)` from
the preview, and read it back from devtools' `consoleLogs`.

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

## Protocol runs must be visible

The original bug: an agent called `runCode` over the protocol, got its result, and the
window showed nothing — the user was looking at a notebook with no trace that anything had
happened. Two things caused it, and both fixes must stay.

1. **The kernel used to drop UI parts for agent runs** (`out.parts = msg.agent ? [] :
   __labS.parts` in `source/run-loop.ts`). It now always sends them: `parts` cross the
   worker boundary, not the protocol boundary, and `__labEncode` has already capped them.
   The agent-facing `out.agent` summary is unchanged and is still what `runCode` returns.
2. **`runCode` bypassed every UI signal.** `src/protocol/run.ts` now also calls
   `logAgentRun`, and `state/run.ts` takes a `RunOrigin` so `runCell`/`runAll` know they
   were called by an agent.

The UI half is `state/agent-runs.ts` + `components/AgentPanel.ts`:

- `mainView` is `'notebook' | 'agent'` — the log is a **sibling view**, full pane, switched
  by the tabs in the toolbar. It is not a panel stacked under the cells (it was, briefly;
  the user asked for tabs).
- `runCode` logs with `focus: true`, which pulls the view over — it has no cell to render
  into. `runCell`/`runAll` do not: their output lands in the cell, so they flash and scroll
  the cell (`flashCellFor` + the `createEffect` in `CellRow`) and only badge the tab.
- Entries render through `OutputView`, the same component a cell uses, which is the whole
  reason a table looks like a table and a chart like a chart in there. Do not fork it.
- Two caps: 50 entries, and every entry's payload goes through `trimOutput` — the layer
  below. The rendered block is height-capped in CSS so one huge result scrolls instead of
  stretching the pane.

**`runCode`'s return value is UI-independent and must stay that way.** Agents parse
`{ ok, logs, result, resultType, truncated, durationMs }`; anything added for the panel
goes into `logAgentRun`, never into the returned object.

## Two truncation layers, do not confuse them

- `__labEncode` — for the **UI**: generous caps (5 000 table rows, 250 KB JSON).
- `__labAgentResult` — for **`runCode`**: a byte budget (`resultLimit`, default 8 KB) that
  fills a row sample until the budget runs out and reports `shape` + `truncated`.
- `trimOutput` in `src/lib/trim.ts` — a third pass before a notebook is written to disk
  (200 rows/part, images over 400 KB dropped), so a notebook file cannot grow unbounded.

`saveResultTo` is handled **inside the worker**, before encoding, so the full value is written
from the sandbox and only a path comes back.

## Chart.js

Never write an explicit `undefined` into a Chart.js options object. A present-but-undefined
`scales.x.type` made Chart.js fall back to a linear axis and render category labels as
0,1,2,3. `buildConfig` (`src/lib/chart-config.ts`) now always names a concrete `type`. Horizontal bars swap which axis
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

## store paths: two tiers, decided by form

`resolvePath` in `src/kernel/paths.ts` is the single decision point, and every operation in
`store-ops.ts` goes through it — so a rule added there applies to `read`/`write`/`list`/
`remove`/`exists` at once. Keep it that way; the old bug was one operation resolving
differently from the others.

- A **bare or relative path is this app's own storage.** That is the default and must stay
  the default: notebooks in the wild are full of `store.readJSON('data/x.json')`.
- **Shared storage takes an explicit `yaar://storage/...` URI** (or the `shared:` shorthand).
- `media` / `media/...` is a *legacy* shared shorthand that predates the URI form. It is the
  one exception to "bare means private", kept because `plot.save` and `exportChart` document
  it. Do not add more exceptions — new ones go through the URI.
- `..` is refused in every form. It used to resolve server-side out of `apps/lab/` into
  neighbouring apps' directories; a URI is the sanctioned way out.
- Errors name the resolved location as a **canonical URI**, never a physical path: under the
  devtools preview the principal is `preview--{projectId}`, so a hard-coded `apps/lab/` in a
  message is wrong exactly where you are most likely to be reading it. The backend's own
  message already carries the physical path.

### The shared listing hazard

`storage.list()` (shared) is typed `Promise<string[]>` in the yaar bundle's `.d.ts`, but at
runtime it returns **entry objects** — mapping `n.endsWith('/')` over the result crashed
every shared listing with `G.endsWith is not a function`, and the type declaration hid it.
`toEntry` in `store-ops.ts` accepts both shapes deliberately. Do not "simplify" it back to
one, and do not trust that signature.

Note the two backends also differ in what they return: app storage yields paths relative to
the app root, shared storage yields paths including the directory prefix (`media/lab/x.png`).

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
