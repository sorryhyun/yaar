# Video Creator — Tier 1 Implementation Plan

## Context

Build a video creation app using Remotion's mental model ("a video is a function of frame number") without Remotion itself. Uses Canvas API + MediaRecorder + existing bundled libs (`@bundled/anime`, optionally `@bundled/three`). No new npm dependencies required.

The existing `video-editor-lite` handles trim/preview of existing videos. This plan evolves it into a **video creator** that can also compose new content from scratch — text animations, shapes, image sequences, video clips, and transitions — all rendered frame-by-frame to a canvas.

## Decisions

- **Extend video-editor-lite** (not a new app) — reuses storage, App Protocol, export, shortcuts
- **Default resolution: 1280x720** (720p, 16:9)

## Architecture

### Core Engine (Remotion-inspired)

```
Composition { width, height, fps, durationInFrames }
  └── Scene[] (ordered by `from` frame)
        ├── TextScene     — animated text (typing, fade, slide)
        ├── ShapeScene    — rectangles, circles, paths with keyframes
        ├── ImageScene    — static/animated image display
        ├── VideoClipScene — existing video segment (uses trim in/out)
        └── GradientScene — animated color backgrounds
```

Each `Scene` implements:
```ts
interface Scene {
  id: string;
  from: number;           // start frame
  durationInFrames: number;
  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void;
}
```

The `frame` argument is **relative** to the scene's start (like Remotion's `<Sequence>`).

### Key Utilities (ported from Remotion concepts)

```ts
// Map a frame range to a value range with easing
interpolate(frame, inputRange, outputRange, options?)

// Spring physics animation (attempt to replicate Remotion's spring())
spring({ frame, fps, damping?, stiffness?, mass? })

// Easing functions
Easing.linear | .easeIn | .easeOut | .easeInOut | .bounce | .elastic
```

These are pure math — no library needed, ~80 lines total.

### File Structure (new/modified files)

```
apps/video-editor-lite/src/
├── main.ts                          # (existing, unchanged)
├── editor/
│   ├── controller.ts                # (modify: add creator mode toggle + composition controls)
│   ├── state.ts                     # (modify: add composition state)
│   ├── types.ts                     # (modify: add composition/scene types)
│   ├── ui.ts                        # (modify: add timeline panel + scene panel)
│   └── utils/time.ts                # (existing, unchanged)
├── core/                            # NEW — composition engine
│   ├── types.ts                     # Composition, Scene, VideoConfig interfaces
│   ├── composition.ts               # CompositionRenderer — frame loop + canvas rendering
│   ├── interpolate.ts               # interpolate(), spring(), Easing
│   └── scene-registry.ts            # Registry of available scene types
├── scenes/                          # NEW — built-in scene implementations
│   ├── text.ts                      # TextScene — animated text
│   ├── shape.ts                     # ShapeScene — geometric shapes
│   ├── image.ts                     # ImageScene — images from storage/URL
│   ├── video-clip.ts                # VideoClipScene — segment of existing video
│   └── solid.ts                     # SolidScene — solid/gradient backgrounds
└── player/                          # NEW — preview + export
    ├── preview-player.ts            # Canvas-based real-time preview (requestAnimationFrame)
    └── exporter.ts                  # Renders all frames → canvas.captureStream() → MediaRecorder → WebM
```

## Implementation Steps

### Phase 1: Core Engine (~200 lines)

1. **`core/types.ts`** — Define interfaces:
   - `VideoConfig { width: 1280, height: 720, fps: 30, durationInFrames }`
   - `Scene { id, type, from, durationInFrames, render() }`
   - `Composition { config: VideoConfig, scenes: Scene[] }`

2. **`core/interpolate.ts`** — Pure math utilities:
   - `interpolate(value, inputRange, outputRange, options?)` with clamping
   - `spring({ frame, fps, config? })` — critically-damped spring
   - `Easing` namespace: linear, easeIn, easeOut, easeInOut, bounce, elastic

3. **`core/composition.ts`** — `CompositionRenderer` class:
   - `renderFrame(canvas, frameNumber)` — clears canvas, iterates active scenes, calls `scene.render(ctx, relativeFrame, config)`
   - Active = scenes where `from <= frame < from + durationInFrames`
   - Scenes rendered in array order (later = on top)

4. **`core/scene-registry.ts`** — Maps scene type string → factory function

### Phase 2: Built-in Scenes (~250 lines)

5. **`scenes/solid.ts`** — SolidScene:
   - Renders a solid color or linear gradient fill
   - Supports animated color transitions via `interpolate()`

6. **`scenes/text.ts`** — TextScene:
   - Properties: text, fontSize, fontFamily, color, position, align
   - Animations: fade in/out, slide, typewriter, scale
   - Uses `ctx.fillText()` with `interpolate()` for animation

7. **`scenes/shape.ts`** — ShapeScene:
   - Rectangle, circle, rounded rect, line
   - Animated position, size, opacity, rotation via keyframes

8. **`scenes/image.ts`** — ImageScene:
   - Loads image from URL or storage path (preloaded before render)
   - Ken Burns effect (slow pan/zoom) via `interpolate()`
   - Fade in/out transitions

9. **`scenes/video-clip.ts`** — VideoClipScene:
   - Wraps an existing `<video>` element
   - Draws current video frame to canvas via `ctx.drawImage(video, ...)`
   - Syncs video.currentTime to composition frame
   - Supports trim in/out (reuses existing trim logic)

### Phase 3: Preview Player (~120 lines)

10. **`player/preview-player.ts`** — `PreviewPlayer` class:
    - Owns a `<canvas>` element
    - `play()` — starts `requestAnimationFrame` loop, advances frame counter by `deltaTime * fps`
    - `pause()`, `seek(frame)`, `getCurrentFrame()`
    - Calls `CompositionRenderer.renderFrame()` each tick
    - Handles audio sync for VideoClipScene (sets video.currentTime)

### Phase 4: Export (~80 lines)

11. **`player/exporter.ts`** — `exportComposition()`:
    - Creates offscreen canvas at composition resolution
    - Uses `canvas.captureStream(fps)` + `MediaRecorder`
    - Drives a `requestAnimationFrame` loop rendering each frame sequentially
    - Collects chunks → `Blob` → download (reuse existing `downloadBlob()`)
    - Reports progress via callback

### Phase 5: UI Integration (~200 lines of changes)

12. **Modify `editor/types.ts`** — Add:
    - `mode: 'edit' | 'create'` to EditorState
    - `composition: Composition | null`
    - `selectedSceneId: string | null`

13. **Modify `editor/ui.ts`** — Add:
    - Mode toggle (Edit / Create tabs)
    - Composition canvas (alongside or replacing the `<video>`)
    - Simple timeline bar: horizontal track with colored blocks per scene
    - "Add Scene" dropdown: Text, Shape, Image, Video Clip, Solid
    - Scene property panel: shows editable properties for selected scene

14. **Modify `editor/controller.ts`** — Add:
    - Mode switching logic
    - Composition CRUD: add/remove/reorder scenes
    - Preview player lifecycle (play/pause/seek on canvas)
    - Export button wires to composition exporter in create mode
    - App Protocol commands for AI-driven composition

15. **Modify `editor/state.ts`** — Add:
    - `setComposition()`, `addScene()`, `removeScene()`, `updateScene()`
    - `setMode()`, `setSelectedScene()`

### Phase 6: App Protocol for AI Composition

16. **Add App Protocol commands** (in controller.ts):
    ```
    createComposition({ width, height, fps, durationInFrames })
    addScene({ type, from, duration, props })
    updateScene({ id, props })
    removeScene({ id })
    reorderScenes({ ids })
    preview()
    exportVideo()
    getComposition()  // state query
    ```
    This lets the AI compose videos programmatically — e.g., user says "make a 10-second intro with my company name fading in over a gradient background" → AI sends `createComposition` + `addScene(solid)` + `addScene(text)` commands.

17. **Update SKILL.md** with composition API docs and example workflows.

18. **Update app.json** description.

## Capability Ceiling (What This Can Do)

| Feature | Status | Notes |
|---------|--------|-------|
| Animated text overlays | Yes | Fade, slide, typewriter, scale |
| Geometric shapes | Yes | Rect, circle, paths with keyframes |
| Image sequences | Yes | Ken Burns, fade transitions |
| Video clips with trim | Yes | Draws video frames to canvas |
| Gradient backgrounds | Yes | Animated color transitions |
| Real-time preview | Yes | requestAnimationFrame at target fps |
| Export to WebM | Yes | MediaRecorder + canvas.captureStream() |
| AI-driven composition | Yes | Via App Protocol commands |
| Audio from video clips | Partial | MediaRecorder captures canvas stream audio only if manually connected |
| Custom fonts | No | Limited to system fonts on canvas |
| Export to MP4/H.264 | No | Browser only supports WebM via MediaRecorder |
| Complex video effects | No | No blur, chroma key, etc. (canvas 2D limits) |
| 3D scenes | Future | Could add via `@bundled/three` rendering to canvas |

## Verification

1. **Build**: `cd apps/video-editor-lite && pnpm --filter @yaar/server exec bun run src/lib/compiler/index.ts` (or just launch `make dev` and load the app)
2. **Edit mode**: Load a video → trim → export → verify WebM downloads and plays correctly (existing functionality preserved)
3. **Create mode**: Toggle to Create → add a Solid scene + Text scene → preview plays on canvas → export produces WebM with the animation
4. **App Protocol**: Open browser console → `window.yaar.app` → call `createComposition`, `addScene` → verify canvas renders
5. **AI integration**: Ask the AI "create a 5 second intro with text 'Hello World' on a blue background" → verify it uses App Protocol to compose and the preview renders correctly
