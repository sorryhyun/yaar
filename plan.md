# Phone text selection — remaining work (issue #123)

Stage 1 landed in `e7d8450a`: long-press selects a word in shell-rendered windows (markdown,
table, text, component), painted with `::highlight(yaar-selection)`, with a Copy / Select all /
Ask AI menu. Code: `components/desktop/PhoneTextSelection.tsx`, `lib/textSelection.ts`,
`lib/copyText.ts`; overview in `packages/frontend/CLAUDE.md` ("Text selection").

## Verify stage 1 live first

Only unit-tested (happy-dom, synthetic touches) plus a desktop-Chrome check of the hit test
and highlight painting. Before building on it, run `make claude-dev-mobile` (or a real Galaxy
PWA) and check:

- The long-press fires, and Android Chrome shows nothing of its own — the `contextmenu` is
  suppressed on window content, and the lift after a claimed touch is `preventDefault`ed so
  no click follows.
- A held finger that then moves does not pan monitors or pull the shade (`claimTouch` →
  `PhoneGestures` drops the drag).
- The Ask AI input is not left under the keyboard (`interactive-widget=resizes-content`
  shrinks `innerHeight`, but `SelectionActionInput` places itself once, before the keyboard
  is up).
- Copy over remote mode on a LAN http address (the `execCommand` fallback).

## Stage 2 — drag handles

- Two handles drawn at the range ends (`getClientRects()` first / last), rendered by
  `PhoneTextSelection` beside the menu, re-placed on the same `layoutTick`.
- Dragging a handle: `caretAt` per move → `range.setStart` / `setEnd`, swapping ends when they
  cross; `setTextSelection` republishes the highlight. A `Range` already spans elements, so
  multi-paragraph selection comes for free; clamp to the window's `[data-window-content]`.
- Auto-scroll the content box while the finger is within ~40px of its top/bottom edge
  (rAF loop), re-probing the caret each frame.
- Handle touches must `claimTouch()` on touchstart (not after a delay) so `PhoneGestures`
  never takes them; the tap-to-clear path must ignore them (like `data-text-selection-menu`).
- Hide the menu while a handle is being dragged; show it again on lift.

## Stage 3 — iframe apps

- Port the stage 1–2 logic to an injected script, `shared/src/iframe-scripts/text-selection.ts`
  (ES5 string like its neighbours), active only when the frame's `yaar.device` form factor is
  `mobile` (`iframe-bridge/device.ts` already pushes it). It needs its own `user-select: none`
  rule for app content, fields excepted, and its own `::highlight` rule.
- The iframe draws highlight and handles; the **menu stays in the parent**: post
  `{ text, rect }` through a new `APP_MSG` entry, translate the rect by the iframe's position,
  render the same `SelectionMenu`. Clearing flows back the other way (tap outside the frame,
  `beginShellDrag`).
- Copy: do it inside the iframe (clipboard permission follows the focused document) or in the
  parent with the text sent over — decide after testing which one Chrome allows.
- Long-press inside the iframe has to reach the frame's existing touch-pan logic
  (`APP_MSG.touchPan` in `iframe-scripts/contextmenu.ts`) the same way `claimTouch` reaches
  `PhoneGestures`.
- Check `contextmenu.ts`'s `dragstart` reading `window.getSelection()` — empty under
  `user-select: none`; phones have no cross-window drag, so likely harmless.
- Out of scope: frames showing external sites (Browser app) — no script can be injected.

## Small follow-ups

- `TerminalPane.tsx` and `QrCodeModal.tsx` call `navigator.clipboard.writeText` directly and
  fail on plain http; they could use `lib/copyText.ts`.
