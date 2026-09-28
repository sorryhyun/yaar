---
name: bundled-libraries
description: Read before importing @bundled/* — how to look a library up, which helper to prefer over hand-rolling, gated SDKs.
audience: agent
---

## Bundled Libraries

Import via `@bundled/*`; no npm install. `query("bundledLibraries")` lists what exists, and
`describeBundledLibrary` returns a library's declarations with their doc comments — entry
points, signatures, what is deliberately missing. **Read it before writing against a
library**; guessed signatures are the usual first-compile failure.

`yaar` and `yaar-web` answer with an **index** (sections → exports → one-line summaries).
Pull what you need from it rather than the whole library:

```ts
command({ command: "describeBundledLibrary", params: { name: "yaar", symbol: "createSharedSignal" } })
command({ command: "describeBundledLibrary", params: { name: "yaar", section: "storage" } })
```

A symbol slice carries every type it references; `full: true` returns everything (~65KB for
`yaar` — rarely what you want).

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
is the grant, with no permission entry.
