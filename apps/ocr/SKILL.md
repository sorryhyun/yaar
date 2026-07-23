# OCR

Reads text out of an image using PaddleOCR's **PP-OCRv6** detection and recognition
models, plus a **PP-OCRv5 Korean** recognizer for Hangul, running entirely in the app
iframe on WebGPU (single-thread wasm fallback) via `@bundled/yaar-ml`. Nothing leaves the
machine; the only network traffic is the one-time model download.

## The three ways to use it

| | |
|---|---|
| `readWindow` | Screenshots another open window and reads it. **This is how OCR reaches things that were never a file** — a rendered app, a chart, a page in the Browser. |
| `readPage` | Finds every line in the loaded image and reads them all. **Start here** when you already handed it an image. No coordinates needed. |
| `recognize` | Reads ONE line inside a box you specify. The escape hatch when detection misses a line, or when you already know exactly where to look. |

`readWindow` is `loadImage` + `readPage` over the OS's own window capture. Both of those
run a detector to locate the text lines, then every recognizer over each line;
`recognize` skips the detector entirely.

## Typical flow

```
app_command loadModels                     # once per window — see below
app_query   windows                        # → [{ windowId, title, detail }, ...]
app_command readWindow { windowId }        # → { window, text, lines: [...] }
```

or, when you already have the pixels:

```
app_command loadImage   { dataUrl }        # or the user drops/pastes one
app_command readPage                       # → { text, lines: [...], truncated }
```

To re-read one line more carefully, take its `box` from the result and pass it to
`recognize` — the image stays loaded, so no second capture is needed.

## Commands

| Command | Params | Notes |
|---|---|---|
| `loadModels` | — | Download the detector and recognizers. **Required before reading** |
| `readWindow` | `{ windowId, download? }` | Capture that window and read it. Get the id from the `windows` state |
| `loadImage` | `{ dataUrl }` | Replaces the loaded image, clears the selection |
| `readPage` | `{ download? }` | Detect + read every line; returns joined text plus per-line entries |
| `recognize` | `{ x?, y?, width?, height?, download? }` | One line. Omit the box to use the selection, else the whole image |

The models are not selectable through the protocol: every read uses the medium
recognizer with the Korean assist. The window's toolbar can still change them.

## State

`status` (busy / loading / message / backend / model ids / **what is still missing** /
image size / selection), `windows` (what `readWindow` can target), `page` (the last
whole-page read), `lastResult` and `results` (single-line history, newest first),
`models` (which scripts each recognizer covers — consult it when a line is
`readable: false`).

## What `readWindow` can and cannot capture

Only **iframe (app) windows** have a screenshot. A `markdown`, `table`, `text`, or
`component` window is already text — read it with `read yaar://windows/{id}` instead of
OCR-ing a picture of it, and `readWindow` says so rather than failing vaguely.

The capture is the window's visible area at CSS resolution — what is scrolled out of
view is not in it, so scroll the window (or make it bigger) before reading if the text
you want is below the fold. A window whose canvas is tainted by a cross-origin image
cannot be captured at all; that error says so, and retrying will not help.

## Reading never downloads

`readWindow`, `readPage` and `recognize` **fail** rather than fetch 152 MB of weights
behind your back — `readWindow` refuses before it captures anything. The error names what
is missing; `status.modelsMissing` says the same thing before you try. Fix it by calling
`loadModels` — or by passing `download: true` to the read, which makes that one call as
slow as `loadModels` would have been.

`loadModels` is the slow one: 152 MB at the default sizes, roughly half a minute on a
fast link. The files land in this app's own storage
(`storage/apps/ocr/models/{model}/inference.onnx`), not in the browser's cache, so they
survive a cleared profile and work offline afterwards. Use a long timeout; if the
transport gives up, poll the `status` state rather than re-issuing it. Loading is tracked
per window, so a freshly opened OCR window needs `loadModels` again — it comes back in
about a second once the bytes are on disk (measured: 889 ms for all 152 MB).

Once warm, a page read is fast: the sample card takes ~270 ms end to end, and a dense
32-line screenshot ~2.4 s. The Korean assist adds a second pass with a mobile-sized
model, so budget roughly a quarter again on top.

`status.backend` says whether WebGPU is in use. On the wasm fallback everything is
several times slower but still correct.

## Reading `readPage` output

- `text` is the whole page: boxes on the same visual line joined with spaces, lines
  joined with newlines.
- `lines[].readable: false` means **detection found a box but no recognizer produced
  anything there.** That is almost always an unsupported script (see below), not a bad
  box. It is reported separately from "found nothing" precisely because the two need
  different responses: an unsupported script needs a different tool, a missed detection
  needs a manual `recognize` box.
- `lines[].readBy` is which recognizer's read was kept. Korean lines come back from
  `korean`, everything else from the primary. `assisted` counts the lines the primary
  did not win — 0 on a page with no Hangul.
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

| Script | `medium` / `small` (18,708) | `tiny` (6,904) | `korean` (11,945) |
|---|---|---|---|
| Latin, digits, punctuation | yes | yes | yes (94 ASCII) |
| Chinese (15,565 CJK ideographs) | yes | yes (6,174) | **no — 0** |
| Japanese kana | yes | **no** | **no** |
| **Korean (Hangul)** | **no — 0** | **no** | yes (all 11,172 syllables) |
| **Cyrillic** | **no — 0** | **no** | **no** |

No single model covers a mixed page, which is why the assist exists: every line is read by
`medium` *and* by `korean`, and the better read is kept. That is what makes a Korean page
— or a Korean page with English in it — readable at all. The window's toolbar can turn it
off, which roughly halves recognition time; the protocol always runs both.

A line in a script none of the loaded models covers still does not error. Through
`readPage` it comes back with `readable: false`; through `recognize` it comes back as an
empty string with confidence 0. Cyrillic is the notable one left — PaddleOCR publishes a
per-language recognizer for it, and this app does not ship it yet.

## Accuracy notes

- `confidence` is the mean per-character probability. Below roughly 0.7, treat the text
  as a guess.
- On `recognize`, give the box a little margin around the text. A box cropped tight to
  the glyph tops and bottoms reads worse than one with a few pixels of padding.
  `readPage` handles this itself.
- Punctuation is where near-misses land: em-dashes come back as hyphens, and a space
  before a bracket is sometimes dropped. Letters and digits are near-exact.
