---
name: realtime-apps
description: Read before building a game, simulation, or render-loop app — per-frame state, input with no command, GPU canvas capture, idle safety, seeding.
audience: agent
---

## Realtime and Render-Loop Apps (fps-lite, mesh-edit, studio-3d)

### Loop state is a plain snapshot, not a signal

The 60fps loop reassigns a plain `let` (`posState = snapshot()`) each frame and the
`defineApp` state getter returns it. No signal writes at 60Hz, no effects meant for UI
firing every frame. The trade: a command's result and the snapshot are not synchronized —
a command that drives input returns nothing about the outcome; re-read state after a
tick. *Seen in:* fps-lite `src/main.ts` (`posState`).

### Continuous input has no command — say so

Movement read from `createKeyState` each frame has no `move` command, and an agent will
search the protocol for one. Either add a discrete command for what an agent needs
(teleport, fire, `walkTo`), or say in `agent/prompt.md` that movement is synthetic
`keydown`/`keyup` plus a read of the position key. Not every effect needs a command, but
its absence must be written down.

### A GPU canvas is readable only in the task that drew it

`WebGPURenderer` has no `preserveDrawingBuffer`, and the loop pauses while the window is
hidden — the normal state of an agent-driven session. A DOM-clone screenshot then shows
a **black canvas**. Expose a capture command that renders synchronously and reads the
canvas in the same task, and return it as an image block (`command-design` topic):

```ts
function captureFrame(): string {
  renderer.render(scene, camera);          // same task as the read
  return canvas.toDataURL('image/webp', 0.9);
}
```

A HUD drawn as DOM over the canvas is not in that capture; if the agent must see it,
expose its values in `state:`. *Seen in:* fps-lite `src/main.ts` (`captureFrame`),
mesh-edit `src/viewport.ts` (`renderNow`).

### Idle inspection must not advance the simulation

A window an agent opened just to read state sits behind a click-to-play overlay; if
enemies keep attacking, the player dies and respawns mid-inspection and the reading is
garbage. fps-lite pauses the simulation unless the pointer is locked (a human is
playing) **or** one of an allow-list of driving commands ran in the last 20s
(`AGENT_PLAY_MS`). The same rule applies to any timer or background consumer: nothing
harmful happens to a window nobody is driving.

### Seed anything procedural

Place procedural content (props, particles, sample data) from a seeded PRNG
(`mulberry32`, default seed in state), not `Math.random()`. Same seed → identical
layout → a `previewScript` baseline can assert it (`regression-testing` topic) instead
of eyeballing a screenshot. *Seen in:* fps-lite `src/dressing.ts`.
