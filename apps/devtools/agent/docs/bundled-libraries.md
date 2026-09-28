---
name: bundled-libraries
description: Read before importing @bundled/* — which library or yaar helper exists, which to prefer over hand-rolling, gated SDKs.
audience: agent
---

## Bundled Libraries

Import via `@bundled/*`; no npm install. `query("bundledLibraries")` lists what exists, and
`describeBundledLibrary` returns a library's type declarations with their doc comments —
entry points, signatures, what is deliberately missing (`solid-js`'s three entry points,
`three/addons`' loaders). **Read it before writing against a library**; this topic only says
what exists and which to prefer.

`@bundled/yaar`'s declarations run to ~65KB, so here is its index. Look a name up there
rather than guessing its signature:

- **Verbs:** `read`, `list`, `invoke`, `describe`, `del`, `subscribe`, `stream`, `httpFetch`.
- **App shape:** `defineApp`, `defineAppCommand`, `createProtocolContext`, `AppCommandError`,
  `links`.
- **Storage and state:** `appStorage`, `appDb`, `createPersistedSignal`,
  `createSharedSignal`, `createAutosave`.
- **UI:** `showToast`, `showConfirm`, `showPrompt`, `withLoading`, `tryToast`,
  `createCollapsiblePanel`, `onShortcut`, `createKeyState`, `isNarrow`, `isTouch`,
  `createMediaQuery`, `onSwipe`.
- **Data:** `sanitizeHtml`, `escapeHtml`, `safeParseOr`, `errMsg`, `wait`,
  `createStaleGuard`, `toWebP`, `downloadBlob`, `blobToDataUrl`, `dataUrlToBlob`,
  `bytesToBase64`, `base64ToBytes`, `formatBytes`, `formatDuration`, `formatClock`.

**Prefer the helper over hand-rolling, every time** — each exists because an app got the
hand-rolled version wrong:

- `showConfirm` over native `confirm()` — a native dialog blocks the page *and* any agent
  driving it.
- `showToast` over custom toast HTML; `errMsg` over `err instanceof Error`; `safeParseOr`
  over a safeParse/log/fallback block.
- `formatBytes`/`formatClock` over a local unit ladder or a hardcoded locale — two windows
  must not render the same value differently.
- `bytesToBase64` over `btoa(String.fromCharCode(...bytes))`, which overflows the stack on a
  few MB.
- `createSharedSignal` for state a command sets and every copy of the window must show
  (`multi-window-sync` topic).

**Gated SDKs** (`@bundled/yaar-dev`, `@bundled/yaar-web`, `@bundled/yaar-media`,
`@bundled/yaar-ml`) need a matching `"bundles"` entry in `app.json` to import — the bundle
is the grant, with no permission entry. What each exports is `describeBundledLibrary`'s
answer.
