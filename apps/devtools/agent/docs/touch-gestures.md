---
name: touch-gestures
description: Read before handling touch, pinch, swipe, or phone layout in an app — pointer pipeline, touch-action, what the shell reserves, how to test.
audience: agent
---

## Touch and Mobile Gestures

The same app runs on a phone, where the iframe gets real touch. The patterns below come
from mesh-edit, studio-3d, image-edit, video-editor-lite and fps-lite, and the constraints
from the shell.

### Check the SDK first

`isNarrow()` (≤768px, the same query as the injected narrow CSS), `isTouch()` (no hover,
44px targets), `createMediaQuery()`, and `onSwipe(el, handler, { ignore, minDistance })`
for one-finger horizontal swipes (a second finger cancels). Never re-derive the shell's
breakpoints.

### One pointer pipeline, a small mode machine

- Drive mouse **and** touch through `pointerdown/move/up/cancel`, branching on
  `e.pointerType === 'touch'` only where behavior differs (the second finger).
- Track fingers in a `Map` keyed by `pointerId`, never an array.
- Disambiguate with an explicit mode enum (`'none' | 'orbit' | 'pan' | 'pinch'`), promoted
  when a second finger lands. **A second finger cancels the single-finger gesture in
  progress** (an armed stroke, a pending tap-pick); it never blends with it.
- **When a pinch ends, the leftover finger is inert** until it lifts (image-edit's
  `'ignore'` mode) or explicitly resumes a pan. Resuming orbit from it jumps the view by
  however far the pinch travelled; starting a stroke from it paints where no one aimed.
- Tap vs drag is a slop test on `pointerup` (≈4–10px), not a separate path. Double-tap is
  the same state with a time and distance window.
- Every input source ends in the **same** commands or deltas: fps-lite's joystick,
  drag-look and gyro all call one `onLook(dx, dy)` in mouse-equivalent pixels.

```ts
const pointers = new Map<number, { x: number; y: number }>();
el.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { cancelStroke(); mode = 'pinch'; seedPinch(); }
  try { el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
});
el.addEventListener('pointercancel', end);   // a cancelled touch never fires pointerup
```

*Seen in:* image-edit `src/ui/viewport.ts`, mesh-edit and studio-3d `src/orbit-camera.ts`.

### The traps

- **`touch-action` decides before any script runs.** Whether the browser zooms the page or
  hands you the pinch is settled from the touched element's `touch-action` (intersected up
  through the iframe); `preventDefault` in the handler is too late. Set `touch-action: none`
  (or the axis you keep) in CSS on the gesture surface.
- **Wire `pointercancel` wherever you wire `pointerdown`** — often on `window` too. The
  browser stealing a gesture for scrolling, palm rejection or an iOS interruption fires
  cancel and never up; without it a drag stays "held" forever.
- **Capture on the narrowest element.** A bottom sheet captures only its grab strip:
  capture held at `pointerup` retargets the click that follows, so capturing on an
  ancestor eats taps on the sheet's own buttons.
- **Pinch with native one-finger scroll needs Touch events, not Pointer events.**
  video-editor-lite's timeline keeps `touch-action: pan-x pan-y` so one finger scrolls;
  Chrome ends the pointer stream once it commits that finger to panning, but Touch events
  keep arriving for the second finger. A non-passive `touchmove` scoped to that element
  handles the pinch.
- **Apply a pinch ratio directly, never through a damped accumulator.** Damping integrates
  `ratio − 1` per frame and compounds; it overshot a pinch about 10×.
- **A trackpad pinch is `ctrl`/`meta` + `wheel`**, not touch — `preventDefault` it or it
  zooms the host page.
- **Gyro:** call `DeviceMotionEvent.requestPermission()` synchronously in the tap handler,
  before any `await`, or iOS refuses silently; it needs a secure context (dead on plain-http
  LAN). `rotationRate.alpha/beta/gamma` are rates about X/Y/Z *in that order* — not
  `deviceorientation`'s Z/X/Y. Rotate by `screen.orientation.angle` for landscape.
  *Seen in:* fps-lite `src/touch.ts`.

### What the shell owns

- **Never add a non-passive `touchmove` on `window` or `document`.** Every isolated app
  shares one origin and so one main thread: a non-passive listener makes every touch scroll
  wait for that thread, and a busy app once froze scrolling in *every* app. Scope any
  non-passive listener to your own gesture element.
- The shell claims drags nothing inside the frame wants: screen-edge gutters for monitor
  pan, pull-up for the palette, pull-down for the shade. It reads your `touch-action` and
  scroll position to decide, so claim an axis by setting `touch-action` (or
  `preventDefault` on your element) — there is no API call.
- **Never write per-frame gesture state to a custom property on `<html>`**: it inherits,
  so the whole tree restyles every frame. Write the transform onto the moving element, and
  commit layout once on release.

### Phone layout

Side panels become a bottom pull-up sheet whose resting height is reserved out of the
viewport (a CSS variable), so the canvas resizes to what is left and nothing draws behind
it; only a transform moves during the drag. crawl renders a few controls twice
(`.desktop-only` / `.phone-only`), pushes one history entry for a full-screen viewer so the
system back gesture closes it, and adds a landscape-phone block (`orientation: landscape
and max-height: 500px`) because a phone on its side is wider than the narrow breakpoint.

### Testing

`MOBILE=1` (e.g. `make claude-dev-mobile`) opens a phone-shaped Chrome whose mouse drags
arrive as real touch streams — the only way to exercise multi-touch on a PC; `curl -X POST
localhost:9231/background` / `/foreground` reproduces Android suspension. The devtools
preview is a desktop frame: verify layout there with a narrow `resizePreview`, and
gestures on the phone emulation or a real device.
