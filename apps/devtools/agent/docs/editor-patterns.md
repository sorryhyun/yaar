---
name: editor-patterns
description: Read before building an editor — document model, undo, drag previews, cloning with cross-refs, derived nodes, shared GPU resources, live embeds.
audience: agent
---

## Editor Patterns (image-edit, studio-3d, mesh-edit, word-excel)

### The document is a description; pixels are a rendering

image-edit keeps the original bitmap plus a stack of described edits (crop, rotate,
filters, mask) and re-renders on every look and every save, so repeated saves never
degrade and any edit stays revisitable. Two consequences:

- **Replace the doc wholesale, but keep untouched sub-fields at the same reference.**
  Key each expensive cache (decoded bitmap, flood-fill samples, gradients) on the
  *field's* identity, not the doc's, and a brightness drag no longer invalidates a 12MP
  selection cache. *Seen in:* image-edit `src/core/compose.ts`.
- **Render and pointer-inverse must read the same derived size.** Using `contentSize`
  in one and `placedSize` in the other crops artwork off-canvas or drifts the brush by
  the fit scale — an invariant no single file shows, so write it into `AGENTS.md`.

### Drag previews: many renders, one undo step

Snapshot the doc at drag start; apply every intermediate value through a history-free
`previewOp` (doc and renderer update, undo untouched); on release restore the snapshot
and push the **final** value once through the normal mutate path. State reads stay live
mid-drag and undo sees one clean step. *Seen in:* studio-3d `src/store/core.ts`
(`beginLiveEdit` / `previewOp` / `endLiveEdit`).

### Undo stacks hold references too

Freeing resources "the current document no longer references" breaks undo: load model B
over A, free A's buffers, undo — dangling ids. Collect refs from the live doc **and every
op still in the undo and redo stacks** before sweeping; a resource stays resident until
its snapshot falls off the stack. *Seen in:* studio-3d `src/store/core.ts` (`keepRefs`).

### Cloning a subtree: rewrite every reference, not just ids

Two passes: build `old → new` over the subtree, then rewrite `id` **and every field that
names another node** (`baseId`, `toolIds`, `mirror.sourceId`). Miss one and editing the
copy silently drives the original. Every new "refers to a node" field must be added to
this function — say so in its header. *Seen in:* studio-3d `src/scene/model.ts`
(`reidSubtree`).

### Derived nodes: bounded re-derive inside the same mutation

For "B is computed from A" (booleans, linked mirrors, formula cells), studio-3d rescans
the whole doc after every mutation, emits patch ops only for real differences, and folds
them into the **same** `mutate()` so an edit and its cascade are one undo step. Passes
are capped (`MAX_PASSES = 8`) because derivations can nest. It is deliberately **not**
run on the drag-preview path — derived results catch up on commit. *Seen in:*
studio-3d `src/store/derive.ts`.

### Shared render resources: dispose the stashed original

When an override (clay/matcap mode, a selection outline) assigns one shared material or
geometry onto many meshes, stash each mesh's original under a `userData` key and have
teardown dispose **the stashed original** — never `mesh.material`, which is the shared
instance every other mesh still draws with. The symptom is black geometry somewhere
else, two files later, with no error. *Seen in:* mesh-edit `src/mesh/render.ts`
(`BASE_MATERIAL`), studio-3d `src/reconcile.ts`.

### Live embeds inside a re-laying-out document

- Moving an iframe reloads it. Keep frames in a persistent `.embed-layer` the layout pass
  never clears, draw placeholders in the flow, and position frames over them after layout
  settles. Key frames by kind + size + source hash + occurrence, so a redraw that keeps an
  equivalent embed keeps it running.
- `sandbox="allow-scripts"`, **never** with `allow-same-origin` — that hands the embed
  this app's storage. Run only visible frames (IntersectionObserver, capped count).
- Sanitizing strips `<script>`, so imported markup that a script fills in arrives as a
  silent empty box. Detect script dependence **before** sanitizing (a script tag, a
  canvas, an `on*` attribute, or an *empty* element a script names) and route that subtree
  to the sandboxed-embed path; a filled element stays static.

*Seen in:* word-excel `agent/docs/embeds.md`.
