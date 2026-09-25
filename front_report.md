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
injection table, dead exports, typed action factory, routing and helpers tests) has landed and
is removed from this report; item numbers are kept so references stay stable.

**Baseline (after Batch A):** `bun run typecheck` clean · `bun run lint` clean (0 warnings,
now incl. shared and compiler) · shared tests 197 pass / 16 files · frontend tests 530 pass /
54 files · compiler tests 449 pass / 27 files.

Items marked **(verified)** were re-checked by hand after the agent audit.

---

## Priority 1 — Do first

### 1.2a `TOOL_PROGRESS` case is doing two jobs

`packages/frontend/src/lib/transport/server-event-dispatcher.ts` — the `TOOL_PROGRESS` case
(~145 lines) mixes five status branches with display-string formatting. Extract the formatting
into named pure helpers and test them; preserve the finalize-before-append ordering documented
in that case.
**Effort:** M · **Risk:** low.

### 1.3 Likely bug: rubber-band selection over app windows

`packages/frontend/src/components/desktop/DesktopSurface.tsx:319-454`
(`handleDesktopMouseDown`) attaches its own `document` `mousemove`/`mouseup` listeners and
tracks them in a ref (105–118, 434–451). It never sets the `yaar-dragging` class on `<html>`.
`beginShellDrag` (`lib/selection.ts:19`) only clears the selection and calls `preventDefault`.

`html.yaar-dragging iframe { pointer-events: none }` is what keeps app iframes from
swallowing pointer events mid-drag, and `hooks/useMouseTracking.ts` exists precisely to
toggle it (plus multi-gesture-safe attach/detach and unmount cleanup). A rubber-band drag
that crosses an open app window can plausibly lose `mousemove` — and if released over the
iframe, `mouseup`, leaving the selection rectangle stuck until the next click.

**Fix:** reuse `useMouseTracking()` for the rubber band. Removes the hand-rolled listener
lifecycle and fixes the bug.
**Verify:** real browser only (happy-dom routes no iframe events and runs no CSS) — drag a
selection across an app window before and after.
**Payoff:** medium-high · **Effort:** S–M · **Risk:** low-medium.

---

## Priority 2 — Duplication worth removing

### 2.1 App launch sequence implemented twice

- `packages/frontend/src/components/desktop/DesktopIcons.tsx:181-271` (`openWindow`/`launch`
  closures in `handleShortcutClick`)
- `packages/frontend/src/store/iframe-bridge/open-url.ts` — `nextBounds()` (74–85),
  `recordOpened()` (91–116), `launchAppWindow()` (213+)

Both do: POST `/api/iframe-token` → validate token → `defaultWindowSize` +
`cascadeWindowBounds` → build `window.create` → push `pendingInteractions`. They have
drifted: DesktopIcons adds focus/restore-if-open and a retry toast; open-url returns `null`
on failure; error messages differ (`'iframe-token response carried no token'` vs
`'iframe-token carried no token'`).

**Fix:** export one launch primitive from `open-url.ts`; DesktopIcons keeps only its
focus-existing and toast behavior on top.
**Payoff:** high · **Effort:** M · **Risk:** low (async path, testable with mocked `apiFetch`).

### 2.4 Shell shortcut dispatch written twice

`packages/frontend/src/components/desktop/DesktopSurface.tsx` — the document-capture handler
(141–184) and the iframe-forwarded `yaar:keydown` handler (205–234) each re-implement:
Shift+Tab → `toggleCliMode`, Ctrl+1–9 → `switchMonitor`, close-window →
`resolveCloseTopWindow` + `userCloseWindow`, and `monitorStepDirection` → `stepMonitor`.

The _decisions_ are already pure and tested in `lib/shellShortcuts.ts`; the _dispatch_ is not.

**Fix:** add `handleShellShortcut(keyInfo, store)` to `lib/shellShortcuts.ts`, returning
whether it handled the key; both handlers call it (the document one still calls
`stopImmediatePropagation`, which the iframe path cannot).
**Verify:** extend `shellShortcuts.test.ts` first; then manually test each shortcut from the
desktop and from inside an app iframe.
**Payoff:** medium-high · **Effort:** M · **Risk:** medium (shortcuts break silently).

### 2.5 Right-click-drag state machine duplicated in DrawingOverlay

`packages/frontend/src/components/drawing/DrawingOverlay.tsx:229-289` (native window
capture listeners) and `295-344` (`yaar:arrow-drag-start/move/end` bridge) implement the same
threshold-gated drag (`DRAG_THRESHOLD`, `rightMovedRef`, `drawLine`, `saveStrokesSnapshot`)
against the same refs.

**Fix:** `beginRightDrag(pt)` / `continueRightDrag(pt)` / `endRightDrag()` over the refs,
called from both event sources (~50 lines removed).
**Verify:** real browser — draw a stroke that crosses a window boundary.
**Payoff:** medium · **Effort:** M · **Risk:** medium.

### 2.6 `device.ts` re-implements the router's source lookup

`packages/frontend/src/store/iframe-bridge/device.ts:26-44` hand-rolls
`querySelectorAll('[data-window-id] iframe')` + `contentWindow === source` for
`APP_MSG.deviceRequest`. `lib/iframeMessageRouter.ts:93-114` (`resolveSource`) exists to
centralize exactly this, and `deviceRequest` is not one of the router's documented
exclusions (timeout-bearing request/response RPCs such as app-protocol replies and capture,
which correctly keep their inline spoof checks).

**Fix:** register via `iframeMessages.on(...)` and use `ctx.source.windowId`.
**Payoff:** medium · **Effort:** S · **Risk:** low.

### 2.7 Image-file filtering (minor)

`CommandPalette.tsx:60-74` and `:267-277` re-write the `type.startsWith('image/')` predicate
that `lib/uploadImage.ts` `filterImageFiles` already provides. Call the helper.
**Payoff:** low · **Effort:** S.

---

## Priority 3 — Cheap cleanup

### 3.2 Raw `'yaar:*'` postMessage literals on the send side

43 raw `'yaar:…'` literals in non-test frontend code (e.g. `DrawingOverlay.tsx`,
`CursorSpinner.tsx`, `DesktopSurface.tsx`, `IframeRenderer.tsx`,
`store/iframe-bridge/{app-events,app-protocol-relay,windows-sdk,subscription-relay,notifications,capture}.ts`),
while `PhoneGestures.tsx`, `drop.ts`, and `device.ts` use `APP_MSG.*`.

The **listen** side is still typo-safe (`iframeMessages.on()` keys are derived from `APP_MSG`).
The **send** side (`postToIframe` / `postMessage` object literals) is not — a typo is a
silent no-op, the same drift the router's comment (`iframeMessageRouter.ts:58`) records
having happened once before.

**Fix:** use `APP_MSG.x` at every send site. Optionally type `postToIframe`'s `type` field
with `AppMessageType` (`packages/shared/src/app-protocol.ts`), which has no importers yet and
was kept for this.

---

## Priority 4 — Test gaps

**Frontend (no coverage at all, confirmed by hand):**

- `components/window/WindowFrame.tsx` (496 lines) — the primary window chrome. Cheapest
  entry point: extract the pure style-variant computation (216–270: card / panel /
  maximized / widget / default) into `computeWindowStyle(...)` and unit-test the five modes.
- `components/desktop/DesktopIcons.tsx` (436) — becomes easier to test after 2.1.
- `components/drawing/DrawingOverlay.tsx` (349) — the math in `lib/gestures.ts` is tested;
  the wiring is not.
- `store/slices/settingsSlice.ts` (247).
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
- `open-url.ts`, `app-protocol-relay.ts` — long but single-owner state machines (aside from
  2.1).
- `lib/gestures.ts`, `gesture-layer.ts`, `shade-pull.ts`, `palette-sheet.ts`, `phoneBack.ts` —
  already factored; remaining per-gesture code genuinely differs.
- `WindowFrame.tsx` structure — already uses `useDragWindow` / `useResizeWindow` /
  `useWindowDrop`; only the style computation is worth extracting.
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

1. **Batch B (small, isolated):** 2.1, 2.6, 2.7, 3.2, 1.2a.
2. **Batch C (needs real-browser verification):** 1.3, 2.4, 2.5 — one at a time, each with a
   manual check in a live desktop.
3. **Batch D (tests):** `computeWindowStyle` extraction + test, `settingsSlice` tests.
