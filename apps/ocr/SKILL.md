# OCR

Reads text out of an image using PaddleOCR's **PP-OCRv6** detection and recognition
models, running entirely in the app iframe on WebGPU (single-thread wasm fallback) via
`@bundled/yaar-ml`. Nothing leaves the machine; the only network traffic is the one-time
model download.

## The two ways to use it

| | |
|---|---|
| `readPage` | Finds every line itself and reads them all. **Start here.** No coordinates needed. |
| `recognize` | Reads ONE line inside a box you specify. The escape hatch when detection misses a line, or when you already know exactly where to look. |

`readPage` runs two models: a detector locates the text lines, then the recognizer reads
each one. `recognize` skips the detector entirely.

## Typical flow

```
app_command loadImage   { dataUrl }        # or the user drops/pastes one
app_command readPage                       # → { text, lines: [...], truncated }
```

To re-read one line more carefully, take its `box` from `readPage` and pass it to
`recognize`.

## Commands

| Command | Params | Notes |
|---|---|---|
| `loadImage` | `{ dataUrl }` | Replaces the loaded image, clears the selection |
| `readPage` | — | Detect + read every line; returns joined text plus per-line entries |
| `recognize` | `{ x?, y?, width?, height? }` | One line. Omit the box to use the selection, else the whole image |
| `loadSample` | — | Built-in multi-script test card; good for checking the models run |
| `setModel` | `{ modelId?, detModelId? }` | `medium` (default) / `small` / `tiny` for each |

## State

`status` (busy / message / backend / model ids / image size / selection), `page` (the
last whole-page read), `lastResult` and `results` (single-line history, newest first),
`models`, `detectors`.

## First call is slow

The first `readPage` downloads a detector (62 MB) and a recognizer (77 MB) before it can
run. Use a long timeout; if the transport gives up, read the `status` state rather than
re-issuing the command. Weights are cached in IndexedDB afterwards, so later calls start
immediately and work offline.

Once warm, a page read is fast: the sample card takes ~270 ms end to end, and a dense
32-line screenshot ~2.4 s.

`status.backend` says whether WebGPU is in use. On the wasm fallback everything is
several times slower but still correct.

## Reading `readPage` output

- `text` is the whole page: boxes on the same visual line joined with spaces, lines
  joined with newlines.
- `lines[].readable: false` means **detection found a box but the recognizer produced
  nothing there.** That is almost always an unsupported script (see below), not a bad
  box. It is reported separately from "found nothing" precisely because the two need
  different responses: an unsupported script needs a different tool, a missed detection
  needs a manual `recognize` box.
- `lines[].box.angle` is the line's tilt in degrees. Rotated text is read correctly —
  the crop is de-skewed before recognition — so a tilted box is not a problem to fix.
- `truncated: true` means detection hit its 3000-box cap and the page is **partial**.

## Two limitations worth knowing before you trust the output

**Columns.** Lines are grouped by vertical overlap, which is right for a normal page and
wrong for two columns side by side: those read across the gutter (left line, right line,
next row) instead of down one column and then the other. The per-line `box` coordinates
are correct regardless, so a caller that cares can re-sort them.

**Perspective.** Rotated text is handled. Text photographed at an angle — a sign, a page
held at a slant — is cropped as a rotated rectangle rather than un-projected, so it
degrades as the perspective gets stronger.

## Which scripts actually work

The upstream model card says "50 languages", but the shipped ONNX exports do not back
that up. Counted directly from the dictionary each model was exported with:

| Script | `medium` / `small` (18,708 chars) | `tiny` (6,904 chars) |
|---|---|---|
| Latin, digits, punctuation | yes | yes |
| Chinese (15,565 CJK ideographs) | yes | yes (6,174) |
| Japanese kana | yes | **no** |
| **Korean (Hangul)** | **no — 0 characters** | **no** |
| **Cyrillic** | **no — 0 characters** | **no** |

A line in an unsupported script does not error. Through `readPage` it comes back with
`readable: false`; through `recognize` it comes back as an empty string with confidence
0. Korean and Cyrillic need a different recognizer (PaddleOCR publishes per-language
ones); this app does not ship them.

## Accuracy notes

- `confidence` is the mean per-character probability. Below roughly 0.7, treat the text
  as a guess.
- On `recognize`, give the box a little margin around the text. A box cropped tight to
  the glyph tops and bottoms reads worse than one with a few pixels of padding.
  `readPage` handles this itself.
- Punctuation is where near-misses land: em-dashes come back as hyphens, and a space
  before a bracket is sometimes dropped. Letters and digits are near-exact.
