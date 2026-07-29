# 3D Studio

A 3D asset viewer and builder. You drive a **scene document** — a plain, serializable
node tree — and the three.js render target is reconciled from it automatically. The doc
is the source of truth; there is no other way to change what is on screen.

The command and state reference is appended below this prompt. Read it there.

## The scene document

`query("scene")` returns the whole tree:

```
{ version, name, root: { id: "root", kind: "group", children: [ … ] } }
```

Each node is `{ id, name, kind: "mesh"|"group", visible, transform: {p,r,s}, geometry?,
material?, children[] }`.

Things that will bite you if you assume otherwise:

- **Rotation is Euler XYZ in DEGREES**, not radians. `{ rotation: { x: 90 } }` is a
  quarter turn.
- **`transform` is `{p, r, s}`**, but `setTransform` takes `position` / `rotation` /
  `scale`. Each is a *partial* `{x?, y?, z?}` — omitted axes keep their current value.
- **Node ids are opaque and regenerated on every load.** Never hardcode one; read
  `scene` or `selection` first. The root group is always literally `"root"`.
- **`geometry.type: "buffer"`** means imported mesh data held outside the doc behind
  `bufferRef`. You cannot edit its shape — `setGeometryParams` only works on procedural
  primitives (`box`, `sphere`, `cylinder`, `cone`, `plane`, `torus`, `torusKnot`).

## Building geometry

Everything routes through the same mutation funnel the UI uses, so a scene you build by
command is identical to one a human clicked together, and `undo` works on it.

```
command("addGroup",     { name: "Robot" })                       → { id }
command("addPrimitive", { type: "cylinder", name: "Torso", parentId: <groupId>,
                          position: { y: 1 }, params: { radiusTop: 0.4, height: 2 },
                          color: "#539bf5" })                    → { id }
command("setMaterial",  { id, metalness: 0.8, roughness: 0.2 })
command("frameAll")
```

`addPrimitive` returns the new id and selects the node. Parent to `"root"` (the default)
or to a group id. Build hierarchies with groups and transform the group to move the whole
assembly.

## Loading models

`loadModel { uri }` reads a `yaar://storage/` path; `loadModel { url }` fetches through
the HTTP proxy. Format is detected from magic bytes first, extension second. **Loading
replaces the entire scene** and resets undo history.

Supported: `.glb`, `.gltf`, `.obj` (+ sibling `.mtl`), `.stl` (binary and ASCII),
`.scene.json`.

The loaders are hand-written (three.js `examples/jsm` is not available in this sandbox),
so a few glTF features are **refused with an explanatory error rather than loaded wrong**:
Draco and meshopt compression, KTX2/Basis textures, and sparse accessors. Skins and
animations load as a static bind pose and report a warning. If a user hits one of these,
tell them to re-export without compression — do not retry, it will fail identically.

Models over ~2M triangles prompt the user for confirmation before loading.

## Rendering an image

`renderPNG` writes to `media/studio-3d/<name>-<timestamp>.png` in the **shared** media
tree, which is how another app gets the image. It renders at a minimum width of 1280
regardless of window size. Pass `path` to override the destination.

Frame the shot before you take it: `frameAll` (or `select` then `frameSelection`) — the
PNG captures the live camera, so an unframed scene renders as an unframed image.

## Saving

`saveScene { name }` writes a `.scene.json` into this app's private storage;
`listScenes` / `openScene` round-trip it. That file is the doc verbatim, so it is also a
valid `loadModel` input.

## The window chrome (for questions about the UI)

Both side panels are **hover-reveal**. They start closed, collapsed to a 24px rail on
each edge labelled SCENE / INSPECTOR; moving the pointer onto a rail slides the panel out
*over* the viewport (the canvas keeps full width, so nothing re-renders), and moving off
slides it shut. The ⌗ button in each panel header pins it open, and the pin persists.
Hover-open is suppressed while a pointer drag that started in the viewport is in flight,
and auto-close is suppressed while an input inside the panel has focus — so orbiting past
a rail and typing in a field both behave.

The state machine is `createCollapsiblePanel` from `@bundled/yaar`, with those two rules
supplied as its `canOpen` / `holdOpen` predicates; `src/ui/dock.ts` holds only what is
specific to a 3D viewport (the drag guard) and the markup glue. Don't fork it back into a
local copy.

The **Storage…** browser lists folders and files from `yaar://storage/`, with breadcrumbs,
a `..` row and an ↑ button. Note for maintenance: the `list` verb does **not** set
`isDirectory` and does not slash-suffix directory URIs — a folder is identified by
`description === "directory"`. Entry names are derived from the URI, which is the
canonical spelling.

## Anti-patterns

- Don't poll `stats` for `fps` — it is a live counter, not a completion signal.
- Don't call `select` with an id from a previous `scene` read if anything has loaded
  since; ids change.
- Don't try to edit imported mesh vertices. Phase 1 has no mesh editing — say so rather
  than approximating with a transform.
- `clearScene` is destructive and resets undo. Confirm with the user first.
