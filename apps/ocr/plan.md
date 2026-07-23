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

# Appendix — YAAR changes this work suggests

### Phase 3 will want a window-capture → OCR path

Making OCR an OS capability means an agent OCR-ing *any* window, not just images the
user dropped in. YAAR already captures windows (`onCapture`, the default DOM+canvas
composite). The missing piece is a way to hand that capture to the OCR app — either the
`controls` mechanism (OCR declaring it can be driven, or another app declaring it drives
OCR) or a verb. Worth designing alongside Phase 3 rather than bolting on after.

The capture arrives as a `data:` URL, which is exactly the shape `loadImage({ dataUrl })`
already takes — so whichever door is chosen, the app side of it is done.
