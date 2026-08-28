# Search — notes for whoever edits this next

Full-text search over YAAR storage, plus app-source cloning and dependency analysis.

## Shape of `src/`

- `main.ts` — `defineApp` entry: the whole protocol (JSON Schema params, deliberately —
  see below) and the top-level view.
- `store.ts` — the single `createStore`. Every panel reads from it; nothing else holds state.
- `protocol.ts` — search, clone, preview loading. Owns `clonePath()`, the guard that keeps
  clone destinations inside Search's private `apps-source/` tree.
- `deps.ts` — the `analyze-deps` engine (regex import parsing, no AST) and its report modes.
- `depsgraph.ts` — the rendered dependency diagram (mermaid mode only).
- `styles/` — one file per region, imported in cascade order by `styles/index.ts`.

## Invariants worth knowing

- **JSON Schema params, not Zod.** `main.ts` evaluates nothing at module scope that needs a
  DOM, but the manifest extractor imports the app in a stubbed-DOM worker; the templates here
  are all inside functions, and the params stay JSON Schema so the extraction cannot be taken
  down by a call result. Do not “upgrade” them without checking `manifest` still matches.
- **Store values are Proxies.** Anything returned from a protocol command or state getter must
  be rebuilt from primitives (`toPlainMatch` in `protocol.ts`), or postMessage throws
  DataCloneError and the state key silently reads as broken.
- **Generated output is filtered client-side, and the cap lands first.** `performSearch` drops
  build output with `isGeneratedPath` (`paths.ts`, kept byte-identical to Dev Tools' `lib/paths.ts`
  so the two searches hide the same set) because the storage grep action takes one positive glob
  and no exclusions. Storage caps the raw match list *before* that filter runs, so a truncated
  built-heavy search can be missing source matches entirely — `state.excluded` and
  `describeSearch()` exist so that is stated rather than read as “not found”. Paths are tested
  relative to the search scope, which is what makes descending into a bundle its own opt-in.
  **The filter lives only in `performSearch`**: `clone-app` and `analyze-deps` walk their own
  trees and must keep working on a clone whose path legitimately contains `dist/`.
- **Two storage trees.** Clones live in Search's PRIVATE app storage (`appStorage`,
  `apps-source/…`); ordinary search reads the shared `yaar://storage/` commons. `deps.ts`
  picks between them off `RootRef.kind`, and `previewDepsFile` must use the same rule as
  `readSource` or a node click reads the wrong tree.

## The dependency diagram

`analyze-deps mode: "mermaid"` stores `state.depsGraph` (untruncated source + the root the node
labels are relative to + the clickable file subset) and, unlike the other modes, does NOT dump
its text into the preview pane — the pane is left free for the file a node click opens.

`depsgraph.ts` renders through `renderMermaid()` from `@bundled/mermaid`, which already applies
the YAAR design tokens and returns sanitized svg. Do not run that svg through `sanitizeHtml`:
it would strip the `<style>` block the diagram themes itself with. Render happens in an effect
after mount because mermaid measures text against a live document.

Zoom is a CSS transform on `.deps-graph` with a `.deps-sizer` sized to `viewBox × zoom`, so the
scrollbars stay honest; the svg gets explicit width/height from its viewBox first, since
mermaid's default `width="100%"` has no fixed size to scale against.

`.deps-body`'s children use `position: absolute; inset: 0` rather than `flex: 1` — Solid's
`html` inserts comment markers that break flex chains.