# OCR Phase 2 — text detection (shipped)

Phase 1 shipped the *recognition* half: point at a box, get text. Phase 2 added the
*detection* half, which turns the app from "read this line" into "read this page".

```
image →  det model  →  probability map  →  binarize  →  components  →  min-area rects
      →  unclip  →  reading order  →  N crops  →  batched rec  →  N lines of text
                                                   └── Phase 1 already did this ──┘
```

The recognizer did not change. Phase 2 is a box *producer* feeding the box *consumer*
that already existed.

## What shipped

| File | |
|---|---|
| `src/detect.ts` | detector weights, resize policy, image → probability map |
| `src/geometry.ts` | DB post-processing — components, hull, min-area rect, unclip, scoring, reading order. Pure, no DOM, no model |
| `src/crop.ts` | detected quad → an upright bitmap, via a Canvas affine |
| `src/pipeline.ts` | the page funnel: detect → order → crop → batch-recognize → assemble |
| `scripts/geometry.test.ts` | 25 hand-computed fixtures for the geometry (`bun test apps/ocr/scripts/geometry.test.ts`) |
| `readPage` command, box overlay, whole-page panel | the UI and protocol surface |

Also in this phase, unrelated to detection: the 77 KB generated `src/charset.ts` was
replaced by a runtime fetch of the model's own `inference.yml` (114 KB, through the same
proxy and IndexedDB cache as the weights), and `scripts/gen-charset.ts` was deleted.
The dictionary now cannot drift from the model it describes.

## The two unknowns the plan flagged, and how they resolved

**The resize policy — settled from source, not by measurement.** `inference.yml` says
`DetResizeForTest: null`, and the class default for that is `limit_side_len 736,
limit_type 'min'`. But the class default is not what runs: PaddleX's text-detection
predictor keeps a set of models that override it, and all three PP-OCRv6 detectors are
named in it (`_TEXT_DET_MAX_LIMIT_MODELS` in
`paddlex/inference/models/text_detection/predictor.py`). The shipped default for these
weights is **960/'max'**. Measured afterwards on both a synthetic card and a real
screenshot, the two policies find *identical* box counts, and 'max' is 2.6–4.4× faster
because it never upscales. `__ocr.resizeAB()` re-runs that comparison on demand.

**Rect-unclip is not an approximation.** The plan flagged expanding the min-area rect
instead of offsetting the polygon as a shortcut to revisit. Reading
`DBPostProcess.boxes_from_bitmap` shows upstream offsets the *quad* too — only the
`box_type: "poly"` path offsets the raw contour, and `"quad"` is the default. Offsetting
a rectangle by `d` with round joins gives a rounded rectangle whose min-area rect is
exactly `(w + 2d) × (h + 2d)`, so this matches upstream rather than approximating it.

## What verification found

One real bug, caught by the rotated-text case: the tilt reported to agents and used to
draw the overlay was the raw min-area-rect axis, which points either way along the box —
lines tilted −8° and +5° were reported as 172° and −175°. Crops were unaffected (they
use the ordered quad), so nothing read wrong; the overlay drew flipped and the protocol
lied. Fixed by deriving the angle from the ordered quad (`quadAngle`), with tests.

Measured on WebGPU (apple metal-3), medium detector + medium recognizer:

| Input | Result |
|---|---|
| Sample card, 4 lines, no coordinates | 4/4 boxes, 4/4 lines exact, 271 ms |
| Dense dark-theme screenshot, 32 lines of 14px mono | 32/32 detected, 0 unreadable, 23/32 *character-exact*; every miss an em-dash or a dropped space before a bracket. 2.4 s |
| Real YAAR screenshot, 1520×981 | 18 boxes, all read, none below 70% confidence, 430 ms |
| Text at −8°, +5°, +12° | 3/3 exact, angles reported within 0.5° |
| Korean + English | Korean detected at 92% and marked `readable: false`; English read exactly |

## Still out of scope

- **Column detection.** Two side-by-side columns read across the gutter. Documented in
  `SKILL.md` rather than half-implemented; fixing it properly means gutter analysis.
- **Perspective.** The crop is affine, so a photo of a sign at an angle degrades. A WebGL
  homography pass is the upgrade path.

---

# Phase 3 — Korean, by running two recognizers (shipped)

Phase 2 measured its own gap: "Korean detected at 92% and marked `readable: false`." The
detector is script-agnostic and boxes Hangul perfectly; the v6 dictionary contains zero
Hangul characters, so the crop came back empty. PaddleOCR's answer is per-language
recognizers, and `korean_PP-OCRv5_mobile_rec_onnx` is 13 MB of exactly that.

It cannot *replace* the v6 model — its 11,945 characters are all 11,172 Hangul syllables
plus 94 ASCII, with no CJK and no kana at all. So both run, and the better read wins per
line.

**Why it drops in unchanged.** Verified before writing any code: the graph is
`x:[N,3,48,W] → [N,T,11947]`, its config says `img_mode: BGR` and `CTCLabelDecode`, and
its dictionary is 11,945 entries — so `11945 + 2` is exactly what `assertPairing` already
expects, and `preprocess`/`decodeCtc` needed no changes. Every recognizer taking the same
tensor is also what lets a page be preprocessed *once* and fed to both models; that split
is `prepareCrops` / `runPrepared`.

**The one judgement call is the arbitration** (`arbitrate.ts`, tested). A recognizer
cannot say "that is not my script" — with no labels for what it sees it emits blanks or a
stray character at high confidence, never an error. So neither routing by language guess
nor asking the models is available; the only evidence is the two decodes. Mean confidence
alone would let one stray character at 0.99 beat a correct ten-character read; summed
confidence would let a long hallucination beat a correct short read. What is used is
confidence shrunk by length, `conf × n/(n+2)`, with the primary keeping anything the
challenger does not beat by 0.05 — so a page does not read differently from one run to
the next. `__ocr.candidates()` re-measures that call on a real line instead of re-arguing
it.

# Phase 3b — the download is its own button (shipped)

Falling out of the above: the default set became 152 MB (62 detector + 77 primary + 13
Korean), all of it fetched as a side effect of pressing "Read page". One action meant
either a 300 ms read or a multi-minute download, with no way to know which was about to
happen and no way to stop it.

So `warm.ts` owns loading, a read *asserts* rather than fetches, and the refusal names
what is missing and how to ask for it. `ensureModels` stays the only path that loads
anything, so an explicit load and a `download: true` read record themselves identically.
Loaded-ness is per page session on purpose: the bytes survive in IndexedDB, but whether
they are there is not something the app can ask the cache, and a remembered "yes" that
turned out to be wrong would put the silent download back in the one place it was removed.

# Still out of scope

- **Cyrillic, Thai, Arabic.** Now a data change rather than a design one — a `MODELS`
  entry plus a dictionary URL, per the same PP-OCRv5 naming — but each needs its own
  end-to-end check before being claimed.

---

# Phase 4 — reading any window, and weights that stay put (shipped)

The appendix below asked for a window-capture → OCR path and guessed it would need a new
door: `controls`, or a verb. It needed neither. Reading `yaar://windows/{id}` already
emits a window capture, and `POST /api/verb` already lifts the image out of the result
into `envelope.images` — so an app with `read` on that URI gets the pixels back beside
the JSON. Devtools has read its own preview that way since it shipped. The whole of
`readWindow` is: read the window, take `images[0]`, hand it to `loadDataUrl`, `readPage`.

Three decisions inside that are not obvious:

- **The refusal comes before the capture.** Capturing replaces whatever image was
  loaded, and a call about to be turned away for missing weights should not have thrown
  that away first. `readWindow` runs `requireLoaded` itself rather than letting
  `runPageRead` raise it three steps later.
- **"No image" is three different answers.** A component or markdown window has no
  screenshot and never will (read it as text); a tainted canvas is deterministic
  (retrying cannot help); a window that has not painted yet is worth asking again. One
  "capture failed" would send a caller round the retry loop for two of them.
- **The permission is `read` + `list`, not `yaar://windows/`.** A bare string grants
  every verb — an OCR app that could `invoke` could close, lock, or drive any window on
  the desktop. Verified from inside the iframe: `read` and `list` pass, `invoke` and
  `delete` come back `Not permitted`.

Falling out of the same pass: `loadSample` and `setModel` left the protocol. Every read
is medium + Korean assist; the sizes stay switchable in the toolbar, where a person can
see what they cost.

## The weights stop living in the browser

`session(remoteUrl)` caches through `fetchWeights` into IndexedDB, which is the
*browser's* store, not the machine's: clearing site data drops it, quota pressure evicts
it, another profile starts from zero. The app was telling agents "cached on disk, usable
offline" about 152 MB that a routine cleanup could evaporate.

`@bundled/yaar-ml` already had the other door — `prefetchWeights` has the server stream
each file to `storage/` over resumable Range requests and returns the same-origin URL to
read it back from, and `session()` takes a local URL straight off disk *without*
mirroring it into IndexedDB. So `weights.ts` now sits in front of every load, and the
dictionaries go the same way: 114 KB is nothing to re-download, but a dictionary that
vanished while the weights survived would report the outage as a corrupt model instead
of a missing file.

The layout is derived from the URL rather than tabulated —
`{owner}/{repo}/resolve/{rev}/{file}` becomes `apps/self/models/{repo}/{file}` — so a
model's weights and its `inference.yml` land in one directory named after where they
came from, and the pairing cannot drift.

Measured on this machine: 152 MB in **32.6 s** cold, and **889 ms** to bring all of it
back after a full page reload, with nothing on the network. Loaded-ness stays per page
session, and now means what it says — *resident on the GPU*, not *downloaded*.

## What verification found

The end-to-end run (memo window, medium + Korean, WebGPU): 632×428 capture, every line
read, and `2026년 7월 14일` correctly attributed to the `korean` recognizer on a page
that is otherwise English. The refusal path leaves `imageSize()` null — the capture
genuinely does not happen. `readWindow` on an unknown id reports
`Window "nope" not found. Use list to see available windows.`

# Still out of scope

- **Below the fold.** The capture is the window's visible area (`clientWidth/Height`),
  so a scrolled-out region is not in the image. Scrolling the target window first is the
  workaround; stitching several captures would be the fix.
- **Non-iframe windows.** Refused with an explanation rather than approximated — their
  content is already text and `read yaar://windows/{id}` returns it.

---

# Appendix — YAAR changes this work suggests (resolved)

### Phase 3 will want a window-capture → OCR path

Making OCR an OS capability means an agent OCR-ing *any* window, not just images the
user dropped in. YAAR already captures windows (`onCapture`, the default DOM+canvas
composite). The missing piece is a way to hand that capture to the OCR app — either the
`controls` mechanism (OCR declaring it can be driven, or another app declaring it drives
OCR) or a verb. Worth designing alongside Phase 3 rather than bolting on after.

The capture arrives as a `data:` URL, which is exactly the shape `loadImage({ dataUrl })`
already takes — so whichever door is chosen, the app side of it is done.

**Resolved in Phase 4, and no platform change was needed** — the `read` verb was already
the door. One thing it did surface: `window.yaar.windows.read()` (the windows SDK) still
declares `includeImage` and an `imageData` field it never populates — it returns the raw
`{ data, images }` envelope instead. Apps that want a capture have to bypass it and call
`read()` directly, as devtools and OCR both do. Fixing that shim is a small, separate
change to `packages/shared/src/iframe-scripts/windows-sdk.ts`.
