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
`dist/` stays a single HTML file. These extensions inline: `.png .jpg .jpeg .gif .svg .webp
.avif .ico .woff .woff2 .ttf .otf .wasm .mp3 .wav .flac .ogg .opus .m4a .aac .webm .glb .gltf
.bin .dat` (`.bin`/`.dat` arrive as `data:application/octet-stream`). That list is the limit:
importing any other binary extension **fails the build** ("sibling asset file(s) that a
single-file app cannot serve") — rename it to `.bin` if a parser takes raw bytes. Put the file under
`src/`, next to the code importing it. Use storage only for genuinely dynamic files —
uploads, generated output, anything that changes without a recompile.

**HTML fragments:** `import panel from './panel.html'` (also `.htm`) gives the file's
**text**, not a data URI — hand it to `innerHTML`, an iframe's `srcdoc`, or `DOMParser`.
`copyFile` from `yaar://storage/...` brings one in like any other asset.

**3D models:** an imported `.glb` arrives as a `data:` URI for `GLTFLoader.parse`
(`describeBundledLibrary` on `three/addons`). A `.gltf` naming a sidecar `.bin` or texture
files cannot resolve those relative URLs against a `data:` URI — export the
**self-contained `.glb`** rather than copying the sidecars in. Before fitting, framing or
animating a model, `inspectModel` it: node names and TRS, each mesh's world bounds (its real
size), and which nodes every clip keys — `node` for one limb's keyframe stats, `keys` for a
clip's keyframes (`range` + `step` to keep it short, `euler` for degrees). To check motion
before writing any runtime code, `pose` the clip: `at` gives every node's world transform and
the posed bounds at that moment, and `node` without `at` gives that node's world path —
parents' animation included, so a Magazine under an animated Rifle is where it really is.
Event markers usually live in `extras` or in named empty nodes; `jumps` flag near-instant
keys such as a hide by scale. Trust `measured`, not `units`, for scale and facing. Never regex
a preview's bundle for the base64 to learn any of that.

**Why not `storage.url(...)`:** the preview runs under a throwaway principal, so anything
hitting `/api/storage/` resolves against a different identity than the deployed app will
use, so a storage-backed asset can 404 in preview and work after deploy, or the reverse. An
imported asset has no identity to get wrong.

**Size:** base64 costs ~33% over raw bytes; the compiler warns past 5MB total. A few hundred
KB of sprites is fine; a video is not — stream that. The one exception to "import it" is a
single asset past ~1MB: ship the file into the app's **own** storage and fetch it at
runtime, never from `shared/`, which the user may prune.

### Assets the user made in another app

When the user says *"the dragon image I generated in anima"* or *"the logo I edited"*, it is
almost certainly in the shared tree (the Shared Storage section of your prompt). List the
producer's directory with `storage:list`, then `copyFile` the `yaar://storage/...` URI into
the project and compile; it inlines like any other asset. Nothing there means the file
exists but was never published (app storage is private to its owner): ask the user to
publish it from the producing app, or `relay` to the monitor, which can reach both trees.
**Never ask another app for the bytes**: `exportDataUrl` and anything shaped like it pushes
a several-hundred-KB base64 string through the conversation; publishing and importing moves
them server-side.
