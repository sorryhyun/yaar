---
name: document-editor
description: Read before building a document, spreadsheet, or slides editor — one block model, measured pagination, live tables in prose, lossy exports.
audience: agent
---

## Document Editor Architecture (word-excel)

`cloneApp` word-excel for the whole thing; this is its skeleton and the decisions that
hold it up. Embeds, positional addressing and the `storage:write` override are in the
`editor-patterns`, `command-design` and `storage-overrides` topics.

### One model, every surface a projection

`docBlocks` — an ordered `Block[]` signal of HTML runs — is the only source of truth. The
rendered pages, the Markdown and HTML text, the slides, and every export are projections
of it; Markdown is generated and parsed back, never stored. A block is a *run* of prose,
split only where a live table interrupts.

**Only the array identity is reactive.** A structural change replaces the array (full
rebuild); a cell edit mutates its table in place and bumps a `uiTick` counter. Replacing
the array per keystroke would tear down every grid widget under the caret. One writer,
`setBlocks`, also garbage-collects tables no longer referenced. *Seen in:*
`src/model/store.ts`, `src/doc/editor.ts`.

### Pagination is measured, not estimated

Render every block into one sheet, read `offsetTop`/`offsetHeight` of each top-level child
in one pass, and break when the running height passes the content box. Nothing splits a
block: an over-tall table gets its own oversized sheet. Record the result (unit → page),
so the agent-facing outline reports a *measured* `startPage`.

```ts
if (hasContent && el.offsetTop + el.offsetHeight - top > limit + 0.5) {
  pushBreak(i); top = el.offsetTop;
}
```

Anything that changes height after the first draw (async diagram render, image `load`, a
cell edit growing a row) must call `schedulePaginate()` again, or breaks go stale.

**Zoom is `transform: scale()`, never CSS `zoom`**: `zoom` rescales the measurements
pagination reads, so page breaks would move as the user zooms. Three nested boxes — a
scrolling wrap, a JS-sized sizer, a scaled stack — and scroll offsets converted on every
scale change, anchored at the viewport centre. *Seen in:* `src/doc/page/paginate.ts`,
`agent/docs/page-layout.md`.

### Tables living inside prose

A table is a registry entry referenced from prose by a `{{table:Name}}` placeholder, never
serialized as text — that is what keeps formulas, styles and merges lossless through a
source-text edit. All tables share **one** formula engine addressed by scope
(`Table1!B2` works from anywhere), with one cycle detector (`#CYCLE!`) and one memo cache
dropped wholesale on any edit. Every value edit, UI or protocol, goes through one door
(`table-ops.ts`) that must never call `setBlocks` for a value change.

### Source view without losing the caret

The source pane is a native `<textarea>` the app never re-renders while it is dirty. It
is re-derived from blocks only when entering source mode or when the document is
replaced, never after a commit (that would reformat text under the cursor). A `dirty` flag
plus a `committing` re-entrancy guard is the whole policy. *Seen in:* `src/doc/source.ts`
(`commitSource`).

### Exports: say what each format loses

Only `.json` round-trips everything. `.md`, `.html`, `.deck.html` and `.docx` each lose a
stated subset (formulas always; docx also merges, diagrams, images, embeds), and the
app's SKILL.md carries the loss table. Two rules keep exports honest:

- **Screen CSS and export CSS are a pair** — every visual rule is restated in the export
  stylesheet, or the file renders differently from the editor.
- **One home per unit conversion** (twips, half-points, px↔pt), used by both the docx
  writer and reader, or the round trip drifts. Header/footer `{page}` must be written as a
  real Word field, not substituted text.

Network fonts are never fetched (no `yaar://http`); report them as `externalFonts`.

### Agent surface

- State keys are *readings*, not dumps: `html`/`markdown` elide `data:` URLs and summarize
  embeds, so they are **not** safe to feed back through `setContent`; full source comes from
  `document`/`exportAs`.
- Blocks, diagrams and embeds are addressed by position and marked `replay: 'never'`.
- Every content command returns `{ index, type, preview, blocks }`, and `outline` reports
  type, level, preview and measured `startPage` — the agent checks where an edit landed
  without a screenshot.

### Testing

A `previewScript` suite of independent groups; `docx-roundtrip` writes a document, reopens
it, and compares structure — the one check of a file the app itself produced. Real-world
fixtures live in the storage commons, and a fixture from a user's bug report is asserted
by structural summary, never by its prose.
