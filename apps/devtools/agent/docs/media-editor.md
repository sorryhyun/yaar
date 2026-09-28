---
name: media-editor
description: Read before building a video/audio/timeline editor — one renderer for preview and export, frame-exact encoding, seek and decode traps.
audience: agent
---

## Media Editor Architecture (video-editor-lite)

`cloneApp` video-editor-lite for the whole thing; this is its skeleton and the decisions
that hold it up.

### Model

- A composition is `{ config: { width, height, fps, durationInFrames }, layers }`; a
  layer holds scenes; later layers and later scenes draw on top. **Time is frames**
  everywhere except video trim points (source seconds). Name that seam in the protocol
  descriptions — it is the unit an agent gets wrong.
- Scenes are **immutable**: every edit builds a new one through a factory registry
  (`scene-registry.ts`, one self-registering file per scene type). "Did this repaint?"
  becomes "does a new object exist?".
- Every way media enters (import button, URL, storage browser, `addVideoScene`) registers
  it in **one media bin**. A source only one panel knows about is invisible to the rest.

### One renderer, two calling conventions

`renderFrame(ctx, frame)` is the only draw path, for preview, stills and export, so they
cannot disagree about pixels. A scene that throws draws an error card instead of
aborting the frame. Timing differs by contract:

```ts
interface Scene {
  render(ctx, frame, config): void;                 // sync, always — playback can't wait
  prepare?(frame, config): Promise<void>;           // stills/export await an exact decode
  prepareEveryFrame?: boolean;
  beginExport?(config): Promise<() => void>;        // open a decoder, return its release
}
```

Preview tolerates a slightly stale frame for smoothness; stills and export never do.

### Export: frame-exact, never `captureStream()`

Recording `canvas.captureStream()` through `MediaRecorder` runs in real time and drops or
duplicates frames under load. Instead, per frame: `await prepare` → `renderFrame` →
`await source.add(frame * dt, dt)` on a mediabunny `CanvasSource`. The `await` is encoder
backpressure, so a long export cannot outrun memory. Audio is mixed offline **before**
`output.start()` (a track cannot be added after). Pick the codec with
`getFirstEncodableVideoCodec` per container, and never write MP4 bytes under a `.webm`
name the caller asked for. Collect every `beginExport` release in an array and run them on
every exit path, with `output.cancel()` on failure. *Seen in:* `src/player/exporter.ts`.

A **trim** export is a different job: mediabunny's `Conversion` passes encoded packets
through with no decode or re-encode (lossless, fast, keeps audio). Do not route it through
the composition renderer. *Seen in:* `src/editor/media/edit-mode.ts`.

### Decode and seek traps

- **Re-seek while playing only past a drift threshold** (0.25s). Seeking every frame
  leaves the element permanently mid-seek and the clip flickers. Paused and export paths
  use a tight tolerance (a fraction of a frame).
- **A detached `<video>` paints nothing until its first seek** in Chrome: nudge
  `currentTime = currentTime` on `canplay`/`loadedmetadata`, or frame 0 is blank.
- **A seek can hang forever** (past EOF, damaged region): race every seek against a
  timeout (2s) and continue.
- **Export decodes sequentially** with a mediabunny `CanvasSink` (small pool), not with
  per-frame `<video>` seeks; the seek path is the fallback for undecodable containers.
- **fps from the container, or `null`** — never a guessed 30. Snap a measured rate
  within 3% of a standard rate (phones record variable frame rate).
- **Evicting a cached `<video>` must detach its source** (`removeAttribute('src');
  load()`): dropping the reference does not stop a `preload="auto"` download. Keep the
  cache bounded and keyed by `src`, not by scene (scenes are rebuilt on every edit).
  *Seen in:* `src/core/media-cache.ts`, `src/scenes/video-clip.ts`.
- **A `blob:` source does not survive a reload.** A saved project reopens it as
  `available: false`; say so rather than failing silently.

### Agent surface

- The descriptor maps are static `const`s; the live controller arrives at mount through
  `createProtocolContext` (`verb-api` topic).
- `updateScene` **merges** `props` — "pass only what changes". Edits to an unknown id
  fail loudly; `removeScene` on an unknown id is a no-op (delete is idempotent).
- Tell the agent to add many scenes **before** previewing: every edit re-renders.
- Verification is `exportScenePNG { time }`: one exact composited frame as an image,
  cheap next to a full export.
- Export progress goes into the same store the toolbar's progress bar reads, so an
  agent-driven export does not look like a hang (`long-running-commands` topic).
- **Known gap:** the export is not cancellable, and a window teardown does not abort it.
  Give a new pipeline an `AbortSignal` from the start.

### Testing

The `previewScript` suite covers CRUD, param errors, stills, and save/reopen through the
protocol. Pointer gestures on the timeline and the final downloaded file are outside its
reach. DOM reads after a fade must wait out the transition, and storage URLs carry a
per-mount token, so never assert on a `src` value.
