---
name: static-assets
description: Read before adding an image, font, audio file or 3D model — import it, never fetch it; size rules and user-made assets.
audience: agent
---

## Static Assets (images, fonts, audio, models)

**Import the file. Do not fetch it from storage.**

```ts
import sprite from './sprite.png';   // → "data:image/png;base64,..."
img.src = sprite;                    // <img>, CSS url(), new Audio(), fetch() all work
```

The bundler inlines the bytes into `dist/index.html`, so no request is made at runtime, and
`dist/` stays a single HTML file. Vouched for: `.png .jpg .jpeg .gif .svg .webp .avif .ico
.woff .woff2 .ttf .otf .wasm .mp3 .wav .glb .gltf .bin`. Anything else with no code loader
inlines too (`.bin` arrives as `data:application/octet-stream`) — the list is what
`copyFile` offers an import line for, not the limit of what builds. Put the file under
`src/`, next to the code importing it. Use storage only for genuinely dynamic files —
uploads, generated output, anything that changes without a recompile.

**3D models:** `import level from './level.glb'` gives `data:model/gltf-binary;base64,...`;
decode it with `atob` and hand the bytes to `GLTFLoader.parse(buf, '', onLoad)` from
`@bundled/three/addons`. A `.gltf` inlines as `data:model/gltf+json` and works the same
when its buffers are embedded — but one that names a sidecar `.bin` or texture files cannot
resolve those relative URLs against a `data:` URI, so export the **self-contained `.glb`**
rather than copying the sidecars in.

**Why not `storage.url(...)`:** the preview runs under a throwaway principal, so anything
hitting `/api/storage/` resolves against a different identity than the deployed app will
use — a storage-backed asset can 404 in preview and work after deploy, or the reverse. An
imported asset has no identity to get wrong, and survives the iframe remount on every
compile.

**Size:** base64 costs ~33% over raw bytes; the compiler warns past 5MB total. A few hundred
KB of sprites is fine; a video is not — stream that. The one exception to "import it" is a
single asset past ~1MB: the bundle cost stops being worth it, so ship the file into the
app's **own** storage and fetch it at runtime — never from `shared/`, which is a staging
area the user may prune — every app can read it, but nothing promises the file is still
there.

### Assets the user made in another app

When the user says *"the dragon image I generated in anima"* or *"the logo I edited"*, it is
almost certainly in the shared tree (the Shared Storage section of your prompt). List the
producer's directory with `storage:list`, then `copyFile` the `yaar://storage/...` URI into
the project and compile; it inlines like any other asset. Nothing there means the file
exists but was never published (app storage is private to its owner): ask the user to
publish it from the producing app, or `relay` to the monitor, which can reach both trees.
**Never ask another app for the bytes** — `exportDataUrl` and anything shaped like it pushes
a several-hundred-KB base64 string through the conversation, where publishing and importing
moves the same bytes server-side.
