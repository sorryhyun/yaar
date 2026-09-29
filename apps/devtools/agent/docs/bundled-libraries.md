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

- `showConfirm`/`showPrompt`/`showToast` over native `confirm()`/`prompt()`/`alert()` — a
  native dialog blocks the page *and* any agent driving it. There is no `showAlert`.
- `showToast` over custom toast HTML; `errMsg` over `err instanceof Error`; `safeParseOr`
  over a safeParse/log/fallback block (the boundary rule is the `external-json` topic).
- `appStorage.trySave` over `try { await save() } catch {}` — a swallowed save keeps
  "Saved" on screen while nothing reaches disk. Clear the dirty flag only on its `true`.
  `createAutosave` and `createPersistedSignal` already route through it.
- `readJsonOr` over `readJson` in a `try/catch` — only it sends `missingOk`, so an absent
  optional file stays out of the session's error log.
- `renderMarkdown` (`@bundled/marked`) over `marked.parse` + `sanitizeHtml`; `sanitizeHtml`
  over importing `@bundled/dompurify` or any hand-rolled sanitizer; `escapeHtml` for *text*
  put into a template string — it covers `"` and `'`, so it is safe inside an attribute.
- `storage.url()` over a hand-built `/api/storage/…` URL (only it carries the iframe token an
  `<img>` needs), and `storagePath(ref)` over parsing a storage reference yourself — every
  `storage.*` method already accepts all four spellings of a stored file.
- `sharedStorage.publish(from)` over read-then-save into the commons: it copies server-side.
  The commons is not a boundary (any app may overwrite it, the user prunes it).
- `toWebP`, `rasterize` and `fonts.inline` over a hand-rolled canvas re-encode, DOM → SVG →
  canvas pipeline, or font subsetter.
- `createPersistedSignal`: `await` its third element before a one-shot effect that reads the
  value (an `onMount` fetch), or it runs on the fallback; pass `debounceMs` when it is bound
  to a text input.
- `formatBytes`/`formatClock` over a local unit ladder or a hardcoded locale — two windows
  must not render the same value differently.
- `bytesToBase64` over `btoa(String.fromCharCode(...bytes))`, which overflows the stack on a
  few MB.
- `createSharedSignal` for state a command sets and every copy of the window must show
  (`multi-window-sync` topic).

**Gated SDKs** (`@bundled/yaar-dev`, `@bundled/yaar-web`, `@bundled/yaar-media`,
`@bundled/yaar-ml`) need a matching `"bundles"` entry in `app.json` to import — the bundle
is the grant, with no permission entry.
