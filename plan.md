# Phone text selection — what is left (issue #123)

Stages 1–3 are in: long-press word selection, drag handles with auto-scroll, and the same
in app frames (`iframe-scripts/text-selection.ts`). Overview in `packages/frontend/CLAUDE.md`
("Text selection").

## Checked only in `make claude-dev-mobile`, not on a real phone

Checked there (CDP touch emulation, Session Logs and Configurations apps): long-press in an app
frame, handle drag across rows, auto-scroll at the frame's bottom edge, the scroller clip,
Select all, Copy, and a shade pull clearing the selection. Still to check on a Galaxy PWA:

- Android Chrome shows nothing of its own in an app frame (the injected `!important`
  `user-select: none` wins over the app's CSS).
- A long-press in a frame followed by a slide scrolls the app. The frame cannot cancel that
  without a non-passive `touchmove`, which every isolated app would then wait on.
- The Ask AI input is not left under the keyboard.
- Copy over remote mode on a LAN http address (the `execCommand` fallback).

## Small follow-ups

- `TerminalPane.tsx` and `QrCodeModal.tsx` call `navigator.clipboard.writeText` directly and
  fail on plain http; they could use `lib/copyText.ts`.
- Out of scope: frames showing external sites (Browser app), where no script can be injected.
