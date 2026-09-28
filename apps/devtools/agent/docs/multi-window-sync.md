---
name: multi-window-sync
description: Read before a command sets view state, plays audio, or moves its own window — a window runs once per desktop and a command reaches only one copy.
audience: agent
---

## One Window, Several Copies

A window runs once **per connected desktop** (a phone plus the companion tab is two
iframes, each with its own memory). A `command` reaches exactly **one** copy, so state a
command sets in a plain signal changes that copy's screen and no other — the user watches
the agent work while nothing happens on theirs. Preview shows one copy, so none of this
is visible there; it surfaces only after deploy.

### What goes in `createSharedSignal`

`createSharedSignal(key, initial, { onRemote })` from `@bundled/yaar` holds a value per
window on the server; every copy follows, and `onRemote(value, prev)` runs in the copies
that did *not* write, to redo the side effects the writer performed. The whole value is
sent on every set, last write wins.

- **Share coarse facts, derive the fast ones.** music-maker's shared `transport` holds
  `{ isPlaying, startedAt, leadInMs }` — never the playhead, which would be many writes
  a second. Every copy computes its own playhead from wall-clock time since `startedAt`.
- **Exactly one copy owns the side effect.** Only the copy whose `play` ran sets a local
  `localAudioActive` flag and drives the real audio; the others only draw. A `stop` from
  any copy reaches the sounding one through `onRemote`, so audio never plays twice and
  never outlives a remote stop.

```ts
let localAudioActive = false;
const [transport, setTransport] = createSharedSignal('transport', idle, {
  onRemote: (t) => { if (!t.isPlaying && localAudioActive) { stopAudio(); localAudioActive = false; } },
});
```

- **Continuous gestures: echo locally on `input`, commit on `change`.** A slider drag
  updates the sound and this copy's view every tick but writes the shared signal only on
  release. *Seen in:* music-maker `src/main.ts`, `src/store.ts`.

### Data already on the server: subscribe and reconcile

Rows in `appDb` need no shared signal — every copy re-reads on a ping. Either use
`appDb.createReactiveCollection`, or `subscribe('yaar://apps/self/db/<collection>', …)`
and refetch. When you refetch by hand, **reconcile by id** and keep unchanged rows at
their previous object identity, so a keyed `For` does not rebuild them and a textarea
mid-edit is not stomped by an unrelated row's ping. *Seen in:* chitchats
`src/store/sync.ts` (`reconcile`).

### An app that moves its own window

Every `invoke(windowUri, 'move')` lands on the OS timeline, so a per-frame walk floods
it. mascot sets `left/top` on its own host element for intermediate frames and invokes
`move` **once** when motion settles — plus on `pagehide`/`visibilitychange`, so an
interrupted walk is not lost. It tracks position as *what it commanded*, never
`getBoundingClientRect()`, which reports the mid-transition value and makes a
walk-to-target loop chase a moving target forever. To tell its own moves from a human's,
it subscribes to its window's `user`-kind stream frames, which its own invokes never
produce. *Seen in:* mascot `src/main.ts` (`commitPos`).
