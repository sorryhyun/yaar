# OCR Phase 2 — text detection

Phase 1 shipped the *recognition* half: point at a box, get text. This plan adds the
*detection* half, which turns the app from "read this line" into "read this page".

Everything marked **verified** below was measured against the real artifacts during
Phase 1 (models downloaded and their ONNX graphs parsed, configs read, pipeline run in
a browser on WebGPU). Everything marked **unconfirmed** is recalled from PaddleOCR's
source and needs checking before it is trusted — those are the ones that will silently
produce plausible-but-wrong output if they are wrong.

---

## Where Phase 1 left off

```
user drags a box  →  crop  →  resize to h=48  →  rec model  →  CTC decode  →  text
```

Working, exact on the sample card at ~30 ms/line on WebGPU. The limitation is the first
arrow: a human has to supply the box.

## What Phase 2 adds

```
image →  det model  →  probability map  →  binarize  →  contours  →  min-area rects
      →  unclip  →  reading order  →  N crops  →  batched rec  →  N lines of text
                                                   └── Phase 1 already does this ──┘
```

The recognizer does not change. Phase 2 is a box *producer* feeding the box *consumer*
that already exists — which is why Phase 1 was worth doing first.

---

## The detection model

**Verified** — graphs parsed from the downloaded `.onnx`, parameters read from
`inference.yml` in each repo.

| | |
|---|---|
| Repo | `PaddlePaddle/PP-OCRv6_{medium,small,tiny}_det_onnx` |
| Sizes | medium 62.0 MB · small 9.9 MB · tiny 1.8 MB |
| Input | `x` float32 `[N, 3, H, W]` — all of N/H/W dynamic |
| Output | `fetch_name_0` float32 `[N, 1, H, W]` — a per-pixel text probability map |
| Normalization | ImageNet: mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`, `scale 1/255`, **BGR** |
| Post-process | `DBPostProcess`: `thresh 0.2`, `box_thresh 0.45`, `unclip_ratio 1.4`, `max_candidates 3000` |

The size choice is independent of the recognizer's — `tiny_det` at 1.8 MB with
`medium_rec` is a sensible default pairing, since detection is a much easier task than
recognition and the tiny detector is 40× smaller than the medium one.

Note the detector has **no dictionary**, so the Phase 1 charset-mismatch class of bug
cannot recur here. Its analogue is the resize policy below.

### The one parameter that is not yet pinned down

`inference.yml` says `DetResizeForTest: null` — i.e. "use the defaults" — and does not
say what they are.

**Unconfirmed:** PaddleOCR's `DetResizeForTest` with no arguments uses
`limit_side_len = 736, limit_type = 'min'` (scale so the *shorter* side reaches 736),
then rounds both sides to a multiple of 32. But `predict_det.py`, the inference entry
point, defaults to `det_limit_side_len = 960, limit_type = 'max'` (scale so the *longer*
side reaches 960). Those are materially different policies, and the TRT dynamic-shape
hints in the yml (min 32×32, opt 736×736, max 4000×4000) are consistent with the first.

This must be settled empirically — run both on the same page and compare box recall —
because getting it wrong does not error, it just detects fewer or worse boxes. Budget
an hour for this alone; it is the highest-risk unknown in Phase 2.

The multiple-of-32 rounding, on the other hand, is structural (the network downsamples
by 32) and safe to assume.

---

## The work

### 1. Detection session and preprocessing — small

Mirrors `model.ts`'s existing shape. Resize per the policy above, normalize BGR with
ImageNet stats, run, get back an `[1, 1, H, W]` map. Reuses `loadRecognizer`'s pattern
(`session()` memoized, weights via `/api/ml-weights`, IndexedDB-cached).

New file: `src/detect.ts`, ~120 lines.

### 2. DB post-processing — the bulk of Phase 2

This is what PaddleOCR does with OpenCV and pyclipper, neither of which exists in the
browser and neither of which is in `@bundled/*`. It has to be written.

New file: `src/geometry.ts`, ~350 lines:

| Step | Approach | Notes |
|---|---|---|
| Binarize | `prob > 0.2` into a `Uint8Array` mask | trivial |
| Contour trace | Suzuki-style border following, or marching squares | outer contours only; DB does not need holes |
| Convex hull | Andrew's monotone chain | O(n log n), ~30 lines |
| Min-area rect | rotating calipers over the hull | ~60 lines; the fiddliest piece to get right |
| Score | mean probability inside the rect; drop below `0.45` | use the *unbinarized* map |
| Unclip | expand the rect by `area × 1.4 / perimeter` | see below |
| Rescale | divide by the resize ratio | back to source-image pixels |

**On unclip.** PaddleOCR offsets the *polygon* with pyclipper. Taking the min-area rect
first and then expanding that rectangle by the same distance is the standard shortcut in
JS ports and avoids a general polygon-offset implementation entirely. It differs from
upstream only for strongly non-rectangular contours, which for text lines is rare. If
box quality disappoints, this is the first thing to revisit — not the last.

**On `max_candidates 3000`.** Upstream caps contours at 3000. Keep the cap, and if it is
ever hit, say so in the status line rather than silently returning a truncated page.

### 3. Crop and deskew — small

**Do not implement a homography.** PaddleOCR perspective-warps the quad; but cropping
from the *rotated rect* instead is a pure affine (rotate + scale + translate), which
Canvas 2D does exactly and natively via `setTransform`. That covers rotated text — the
common case — and only genuinely perspective-distorted text (a photo of a sign at an
angle) degrades. A WebGL homography pass is a later refinement, not a prerequisite.

Add to `src/detect.ts` or a small `src/crop.ts`, ~60 lines.

### 4. Batched recognition — small, but the perf-critical piece

The recognizer's batch dimension is dynamic, so N crops can go through in one `run`.
Phase 1 already snaps widths to buckets `[160, 320, 480, 640, 960, 1280, 1920, 2400]`
precisely so this works: group crops by bucket, one batched call per bucket.

This matters more than it looks. onnxruntime's WebGPU backend compiles kernels per
concrete shape; a 40-line page run one-at-a-time at 40 distinct widths would pay 40
compiles. Bucketed and batched, it pays at most 8, once.

Extend `recognizeCrop` in `model.ts` into a `recognizeCrops(crops[])`. Keep the
single-crop entry point — the Phase 1 UI and the `recognize` command both use it.

### 5. Reading order and assembly — small

Sort boxes into lines: group by vertical overlap, then left-to-right within a group.
Naive top-to-bottom sorting breaks on two-column layouts, but column detection is
explicitly *out of scope* — say so in `SKILL.md` rather than half-implementing it.

New file: `src/pipeline.ts`, ~120 lines, tying detect → crop → batch-recognize → assemble.

---

## UI and protocol changes

**UI.** The existing selection box becomes optional rather than required:

- A **Read page** button runs the full pipeline.
- Detected boxes draw as an overlay on the canvas; clicking one shows its text.
- The results panel gains a "whole page" entry (joined text, copyable) alongside the
  existing per-line rows.
- Manual selection stays exactly as it is — it is the escape hatch when detection
  misses a line, and it is the only thing that works on an unsupported script.

**Protocol.** Add one command; keep the rest:

```
readPage()  →  { text, lines: [{ text, confidence, box: {x,y,w,h,angle} }], truncated }
```

That is the call Phase 3 actually wants — an agent handed a screenshot wants the page,
not a box-by-box conversation. `recognize({x,y,w,h})` stays for targeted reads.

---

## What could go wrong

| Risk | Mitigation |
|---|---|
| Resize policy is the wrong one (see above) | measure both before building on either |
| Min-area rect subtly wrong → skewed crops, garbage text | unit-test the calipers against hand-computed rects *before* wiring it to the model |
| Rect-unclip too crude → clipped glyphs | compare against upstream on the same image; fall back to polygon offset only if measurably worse |
| Two sessions live at once (62 + 77 MB) | pair `tiny_det` with `medium_rec` by default; `capabilities().maxStorageBufferBindingSize` was 4 GB on this machine, so headroom is fine here but not everywhere |
| Contour tracing slow in JS | a 736×736 mask is 542k pixels — a single pass is sub-millisecond; not a real risk, but measure rather than assume |
| Empty text on unsupported scripts still looks like a detection failure | detection *will* find Korean text boxes the recognizer cannot read — surface "detected but not readable" distinctly from "not detected" |

That last row is a genuine new failure mode Phase 2 introduces, and worth designing for
rather than discovering.

---

## Verification plan

Phase 1's approach worked well and should be repeated: build the headless hook first,
drive it over CDP, assert on structured output rather than screenshots.

1. **Unit-level, no model:** hull and min-area rect against hand-computed fixtures.
   These are pure functions — this is the one part of the pipeline that can be tested
   without a GPU, so test it properly.
2. **Detection only:** run on the Phase 1 sample card, assert 4 boxes at roughly the
   known line rects (the sample generator already exposes `sampleLineRect(i)`, so
   ground truth is free).
3. **End to end:** extend `readSample` into `readPage` and assert exact text on all
   four lines — the same bar Phase 1 cleared.
4. **Real screenshots:** a YAAR window (dark theme, 13–15px UI text — verified working
   in Phase 1), a dense document, a photo. Report line recall, not just spot checks.
5. **Both resize policies**, side by side, on the same inputs.

---

## Sizing

| | |
|---|---|
| Geometry (hull, calipers, contours, unclip) + its tests | ~1 day, and it is where the risk is |
| Detection session, crop, batching, assembly | ~half a day |
| UI overlay + `readPage` command | ~half a day |
| Verification, incl. settling the resize policy | ~half a day |

The geometry is the whole job. Everything else is plumbing that follows Phase 1's
existing shape.

---

# Appendix — YAAR changes this work suggests

Found while building Phase 1.

Six of the seven have landed and are no longer listed here: the `data:`/`blob:` fetch-proxy
bug, `releaseSessions` and `prefetchWeights` in `@bundled/yaar-ml`, the shape-bucketing and
model-vs-dictionary notes in `docs/guides/yaar_ml_runtime.md`, and `GET /api/dev/preview/{appId}`
(standalone app preview with a token injected — documented in `docs/guides/app-development.md`).
What remains is the one that is a design question rather than a fix.

### Phase 3 will want a window-capture → OCR path

Making OCR an OS capability means an agent OCR-ing *any* window, not just images the
user dropped in. YAAR already captures windows (`onCapture`, the default DOM+canvas
composite). The missing piece is a way to hand that capture to the OCR app — either the
`controls` mechanism (OCR declaring it can be driven, or another app declaring it drives
OCR) or a verb. Worth designing alongside Phase 3 rather than bolting on after.

The capture arrives as a `data:` URL, which is exactly the shape `loadImage({ dataUrl })`
already takes — so whichever door is chosen, the app side of it is done.
