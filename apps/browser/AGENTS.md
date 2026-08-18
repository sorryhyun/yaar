# Browser (appId: `browser`)

A window onto a **server-side** Chrome session. It renders someone else's browser; it
never navigates its own frame. Two render paths exist and are mutually exclusive:

- **still** — an `<img>` refreshed from `/api/browser/{id}/screenshot`, driven by an
  SSE stream of `{url, title, version}` frames. This is the agent's view.
- **live** — a WebSocket screencast painted onto a `<canvas>`, with the human's mouse,
  wheel, keyboard and IME forwarded back as CDP input. Pre-P0 spike.

Running both at once would charge the same remote page for two encodes per frame and
make the fps readout a lie, so entering live mode calls `stopPolling()` and leaving it
calls `startPolling()`. That invariant is spread across `session.ts` (`toggleLive`) and
`live/tabs.ts` (`followTab`) — both must keep it.

## Module map

```
main.ts          entrypoint: connect SSE, register the app, honour ?url=
protocol.ts      the agent contract (state + 4 command groups). Declarations only.
view.ts          all markup: UrlBar / QualitySelect / TabStrip / Stage / LiveStatsBar
session.ts       which browser we are driving; live, quality and tab switches
store.ts         display signals (url, title, loading, placeholder, lock)
endpoints.ts     every /api/browser/... URL, with the iframe token attached
dom.ts           the shared <img> handle (see "no cycles" below)
actions.ts       toolbar handlers + the still-screenshot refresh
sse.ts           the event stream and the 200 ms still-screenshot poll
schema.ts        zod boundary schema for SSE frames
live/index.ts    barrel + the live-mode design notes; implementation beside it
  live/state.ts    signals and types
  live/context.ts  socket / canvas / IME anchor / remote viewport (imports nothing)
  live/socket.ts   connect, disconnect, text control protocol
  live/paint.ts    binary frame -> canvas
  live/seed.ts     still HTTP capture -> canvas (see "A tab switch repaints")
  live/stats.ts    fps, kbps, dropped, input-to-pixel lag (window closed by a clock)
  live/fallback.ts forced captures when the stream goes silent (see "Only the frontmost")
  live/input.ts    pointer, wheel, keyboard, viewport sync
  live/ime.ts      the hidden anchor that makes composition possible
```

## No cycles

The import graph is acyclic and should stay that way. Two files exist only to keep it so:

- **`dom.ts`** owns the screenshot `<img>` because both `actions.ts` and `sse.ts` write
  to it. Before, `sse.ts` ran `import('./actions')` *inside its 200 ms interval* to dodge
  the cycle — a dynamic import five times a second.
- **`live/context.ts`** owns live mode's mutable handles and imports nothing, so
  `live/ime.ts` can `send()` without importing `live/socket.ts`, which imports it.

The one-way edges worth remembering: `live/socket -> {paint, tabs, ime, input, stats,
fallback}`, `live/input -> live/ime`, `live/tabs -> sse`, `sse -> actions`, `{live/socket,
live/tabs, live/input} -> live/seed`, `session -> {live, sse, actions}`. Never the reverse.

`live/stats.ts` and `live/fallback.ts` both reach `live/context.ts` and never each other:
the "a repaint is owed" flag that `markInput` sets and the fallback reads lives in
`context.ts` for exactly that reason. Putting it in either module would have made the two
import each other, and `markInput` has nine call sites across `input.ts` and `ime.ts`.
`sse.ts -> live/state.ts` is also fine — `state.ts` imports nothing.

## A tab switch repaints from HTTP, not from the socket

Chrome's screencast emits a frame **only when the page repaints**. Attaching the socket
to another target therefore paints nothing at all: a tab being switched *back* to is
sitting still by definition, so the canvas kept showing the last frame of the tab we
left — read as the current page, which is the bug `live/seed.ts` exists to fix.

So every path that changes which target is on screen ends in a forced re-capture:

- live, via `switchLiveTab` and the socket's `ready` frame — `seedCanvas(browserId)`,
  one `/screenshot?fresh` painted onto the canvas. Addressed by id, so it is the right
  tab's pixels even before the attach lands, and dropped if a real frame beats it.
- still, via `switchTab` — `refreshScreenshot(true)`, the same `fresh` re-capture.

The same reasoning is why `syncViewport` sets the remote size it just asked for: a page
that never repaints reports no frame, and the canvas is no longer blank in that case, so
a click on it has to map to page coordinates before any frame has arrived.

## Only the frontmost target composites

Chrome renders the frontmost target and only that one. `Page.startScreencast` against any
other target attaches without complaint and then emits **nothing at all** — so a tab the
user switches back to streams zero frames while its page is fully alive. Input is
forwarded, the remote page really scrolls, and the canvas sits on whatever the seed last
painted. That is the whole of "탭을 전환하고 다시 돌아오면 스크롤이 안 먹는다".

Measured, not assumed: a tab reading 36 fps drops to 0 the moment a newer tab takes the
foreground, and reads 36 again once it is frontmost. Reconnecting the socket does not
revive it, and neither does navigating the tab — so no client change can *fix* this. The
fix belongs in the server's screencast `attach` handler, which has to activate the target
(`Target.activateTarget` / `Page.bringToFront`) before the screencast will produce frames.

`live/fallback.ts` is the client's mitigation. The still endpoint *does* answer for a
background target, so when input has been forwarded and no frame has answered it for
~900 ms, it forces a `fresh` capture of that tab. In practice the capture usually does not
reach the canvas — forcing it makes the target rasterize, Chrome emits a real frame, and
`seed.ts` correctly drops the stale still. Either way the page visibly moves: 4 wheel
scrolls produced 0 canvas repaints before this and 2-5 after. A few frames per second is
not a stream, which is why the server fix still needs doing.

So: **a moving canvas with fps near 0 means the stream is silent and the fallback is
carrying it.** The fallback is dormant when the stream is healthy — it fires only when
input is outstanding *and* nothing has painted — and a healthy tab measures 0 captures.

## What the stats readout means

`live/stats.ts` reports over a fixed wall-clock window, closed by a clock rather than by
the next frame. It used to advance only when a frame was painted, which made it lie in
precisely the situation worth measuring: a stream that goes quiet leaves the window open,
and the next frame — a tab switch and thirty seconds later — is divided by the whole idle
span. `Live 3 fps / 29333 ms / 460 kbps` was one such reading on a link that was never
slow; the three numbers were the same artifact seen three ways.

Two rules keep it honest, and both matter: an input mark expires (`LAG_EXPIRY_MS`), so one
unanswered input cannot poison every later reading; and `switchLiveTab` resets the
counters, because they are per-tab, not per-connection.

## Protocol

`protocol.ts` uses **JSON Schema literals, not Zod**, and each descriptor is wrapped in
`defineAppCommand` so its schema still types its own `run` after being spread into
`defineApp`. Keep it that way: `view.ts` evaluates `html` templates, and a Zod `params`
would force the compiler to import the app in a stubbed-DOM worker to read the schema,
which those templates break.

Commands are grouped (`navigationCommands`, `interactionCommands`, `inspectionCommands`,
`uiCommands`) and spread in order in `main.ts`. The spread order is the manifest order —
changing it is a visible protocol change even though no command changed.

Every verb call gets its session id from `browserOpts()` / `ensureBrowserId()` in
`session.ts`, which lazily creates a hidden session when the window was opened without
`?browserId`. Never read `activeBrowserId()` directly in a command handler.