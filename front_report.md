# Frontend / Shared Refactor Headroom Report

_Audit date: 2026-09-25 · Scope: `packages/frontend/src` (~18k LOC) and `packages/shared/src` (~7.3k LOC), tests excluded from counts · Read-only audit, nothing edited._

## Summary

Both packages are in better shape than their file sizes suggest. The largest files
(`PhoneGestures.tsx`, `store/desktop.ts`, `slices/windowsSlice.ts`, `iframe-bridge/open-url.ts`)
have already been deliberately factored, and their branches are documented against specific
past bugs — splitting them for size alone is not recommended. The real headroom is narrower:
one likely interaction bug, several duplicated code paths, and test gaps on a few central
components.

Batch A (shared/compiler lint coverage, dispatcher casts, window-key suffix helper, script
injection table, dead exports, typed action factory, routing and helpers tests), Batch B
(one app-launch primitive, `device.ts` on the router, image-filter reuse, `APP_MSG` at send
sites with `postToIframe` typed by `AppMessageType`, `TOOL_PROGRESS` formatting helpers),
Batch C (rubber band on `useMouseTracking`, `handleShellShortcut` / `applyMonitorStep`, one
right-drag state machine in `DrawingOverlay`) and Batch D (`computeWindowStyle` + tests,
`settingsSlice` tests) have landed and are removed from this report; item numbers are kept
so references stay stable.

Batch C was verified live, over CDP with multi-step mouse and key input against a running
desktop: a rubber band crossing an app window keeps `yaar-dragging` on and its `mouseup` in
the shell; right-drag strokes draw from the desktop into a window and from inside an iframe
(bridge path), and a sub-threshold right-click draws nothing; Shift+Tab, Ctrl+1..9,
Shift+→ and Ctrl+W work both from the shell and from a focused app iframe. The live run also
turned up a pre-existing bug the 1.3 fix would have made universal: the `click` that follows
a band's `mouseup` lands on the desktop background and cleared the selection the band had
just made (releasing over an iframe used to dodge it only because that click never reached
the shell). The band now swallows that one click.

**Baseline (after Batch D):** `bun run typecheck` clean · `make lint` clean · frontend tests
593 pass / 61 files.

Items marked **(verified)** were re-checked by hand after the agent audit.

---

## Priority 3 — Cheap cleanup

### 3.3 Dead `windows-sdk` listener (found in Batch B)

`packages/frontend/src/store/iframe-bridge/windows-sdk.ts` (`initWindowsSdkHandler`, called at
`store/desktop.ts:544`) answers `yaar:window-read` / `yaar:window-list`, but nothing in the repo
posts either — the iframe-side windows SDK now reads through the verb SDK
(`yaar.read('yaar://windows/…')`). These are also the last raw `'yaar:*'` literals left after
3.2, since they never got `APP_MSG` entries. **Fix:** delete the module, its barrel export and
the init call. **Effort:** S · **Risk:** low.

### 3.4 `replayed` never reaches an app command handler (found in Batch B)

`AppCommandRequest.replayed` (`packages/shared/src/app-protocol.ts:348`) is read by the iframe
script (`iframe-scripts/app-protocol.ts:681`, `ctx.replayed`), but the relay in
`store/iframe-bridge/app-protocol-relay.ts` builds `{ type, requestId, command, params }`
without it, and nothing in the server sets `replayed: true`. So `ctx.replayed` is always
false. Decide whether the flag is still wanted (then thread it server → relay) or remove it
from the protocol. **Effort:** S–M · **Risk:** low.

### 3.5 `loadSettings` does not validate `iconSize` (found in Batch D)

`store/slices/settingsSlice.ts` clamps `theme`, `handedness` and `windowSize` from
`localStorage` against their known values, but passes `iconSize` through unchecked. Harmless
today — `resolveIconSize` falls back to `medium` on an unknown key — but inconsistent;
`tests/store/settingsSlice-load.test.ts` pins the current behaviour. **Effort:** S ·
**Risk:** low.

---

## Priority 4 — Test gaps

**Frontend (no coverage at all, confirmed by hand):**

- `components/desktop/DesktopIcons.tsx` — the launch itself is now tested via
  `launchAppWindow`; the focus-existing / retry-toast wiring is not.
- `components/drawing/DrawingOverlay.tsx` — the math in `lib/gestures.ts` is tested and the
  right-drag state machine is now one set of functions, but the wiring is only verified live.
- `components/overlays/TerminalPane.tsx` (186).
- The caching selectors in `store/selectors.ts` — pure functions, only covered indirectly via
  integration tests.

**Shared (no package-local tests):**

- `events/client.ts`, `events/server.ts` (~820 lines, the WS contract), `bridge.ts`
  (covered from server tests), `component-types.ts`, `iframe-scripts/verb-sdk.ts`,
  `design/app-css.ts`, `design/shell-css.ts`.

---

## Watch items (do not act yet)

- **`device-sdk.ts` / `notifications-sdk.ts` "listenable" pattern** — identical
  callbacks-array + `notify` + `onChange`-with-unsubscribe shape
  (`device-sdk.ts:35-36,81-87`, `notifications-sdk.ts:15-16,32-39`). Two consumers; per the
  two-consumer extraction rule, extract into a `prelude.ts` fragment only when a third SDK
  script needs it.
- **`iframe-scripts/app-protocol.ts` (714 lines)** — five concerns in one IIFE, but it is
  ES5 string-interpolated with no module system, so splitting only aids source readability.
  If it passes ~900 lines, the clone/plainify block (~306–478) splits cleanest into its own
  template constant. Diff build output if ever done.

## Leave alone

- `PhoneGestures.tsx` (869) — one `document` listener owning the touch stream and shared
  axis-lock refs is deliberate; splitting would thread shared refs across modules.
- `store/desktop.ts`, `slices/windowsSlice.ts` — dense but each branch is load-bearing and
  documented against a past bug.
- `open-url.ts`, `app-protocol-relay.ts` — long but single-owner state machines.
- `lib/gestures.ts`, `gesture-layer.ts`, `shade-pull.ts`, `palette-sheet.ts`, `phoneBack.ts` —
  already factored; remaining per-gesture code genuinely differs.
- `WindowFrame.tsx` structure — already uses `useDragWindow` / `useResizeWindow` /
  `useWindowDrop`, and the style computation is now `computeWindowStyle`.
- `CommandPalette`'s hand-rolled outside-press listener — documented as deliberate (paired
  with a `window blur` signal `useDismissable` does not know about).
- Shared: `components.ts` / `component-types.ts` (`AssertPropsCovered` cross-check),
  `APP_MSG`, `bridge.ts`, `schemas.ts`, `yaar-uri.ts`, design CSS generators (WASH rules
  documented in `app-css.ts`).
- Import cycles — `madge` reports 27, but 23 are type-only `store/types.ts ↔ slices/*` and the
  rest are the single runtime cycle through `store-access.ts` that
  `packages/frontend/CLAUDE.md` already documents. `store/` never imports `components/`.
- Type escape hatches — 28 `any` / 4 `as unknown as` / 1 `@ts-expect-error` in frontend,
  12 / 1 / 0 in shared, spread 1–2 per file with no dumping ground.

---

## Suggested sequencing

1. **Anytime:** 3.3, 3.4, 3.5.
2. Remaining test gaps (Priority 4) as the surrounding code is next touched.
