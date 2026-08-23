---
name: bundled-libraries
description: Read before importing @bundled/* — solid-js entry points, the yaar helper roster, gated SDKs.
audience: agent
---

## Bundled Libraries

Import via `@bundled/*`; no npm install. `query("bundledLibraries")` lists what exists;
`describeBundledLibrary` documents any of them — read it before writing against a library.

```ts
import { v4 as uuid } from '@bundled/uuid';
import { animate, createTimeline } from '@bundled/anime';
```

- **`solid-js`** — reactive UI, split across three entry points that are easy to confuse.
  `import { createSignal, createEffect, For, Show } from '@bundled/solid-js'`;
  `import html from '@bundled/solid-js/html'` (**default** export, not named);
  `import { render } from '@bundled/solid-js/web'`. Reaching for `render` or `html` on
  `@bundled/solid-js` is the usual first-compile failure. Prefer `import './styles.css'`
  over inline styles.
- **`three`** — core only on `@bundled/three`; the loaders and controls live behind a
  second entry point, `@bundled/three/addons` (`GLTFLoader`, `OBJLoader`, `STLLoader`,
  `GLTFExporter`, `OrbitControls`, `PointerLockControls`, `TransformControls`,
  `BufferGeometryUtils`, ...). Same shape of trap as solid-js, and the expensive one: two
  apps hand-rolled a glTF reader before anyone found it. `DRACOLoader`/`KTX2Loader` are
  absent on purpose — they fetch a decoder from a sibling path a single-file app cannot
  serve. `PointerLockControls`, and any hand-rolled `requestPointerLock`, needs a
  drag-to-look fallback: a click you dispatch never takes the lock (`preview-debugging`).
- **`yaar`** — the Verb API (`read`, `list`, `invoke`, `describe`, `del`, `subscribe`,
  `stream`, `httpFetch`) plus helpers: `defineApp`, `defineAppCommand`,
  `createProtocolContext`, `appStorage`, `appDb`, `sanitizeHtml`, `escapeHtml`,
  `safeParseOr`, `showToast`, `showConfirm`, `showPrompt`, `errMsg`, `AppCommandError`,
  `withLoading`, `tryToast`, `wait`, `createStaleGuard`, `onShortcut`, `createKeyState`,
  `createPersistedSignal`, `createCollapsiblePanel`, `createAutosave`, `toWebP`,
  `downloadBlob`, `blobToDataUrl`, `formatBytes`, `formatDuration`, `formatClock`.
  **Always prefer the helper over hand-rolling**: `showToast` over custom toast HTML,
  `showConfirm` over native `confirm()` (native dialogs block the page *and* any agent
  driving it), `errMsg` over `err instanceof Error`, `safeParseOr` over a
  safeParse/log/fallback block, `formatBytes`/`formatClock` over a local unit ladder or a
  hardcoded locale (two windows must not render the same value differently). `defineApp`
  takes `events`, `onCapture` and `onClose` on top of the fields covered in the
  `verb-api` topic.

**Gated SDKs** (`@bundled/yaar-dev`, `@bundled/yaar-web`) need a matching `"bundles"` entry
in `app.json` to import; what each exports is `describeBundledLibrary`'s answer, not this
document's.
