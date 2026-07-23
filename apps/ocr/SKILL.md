# OCR

Reads text out of an image using PaddleOCR's **PP-OCRv6 recognition** model, running
entirely in the app iframe on WebGPU (single-thread wasm fallback) via `@bundled/yaar-ml`.
Nothing leaves the machine; the only network traffic is the one-time model download.

## The one thing to understand

This is a **single-line recognizer**, not a full OCR pipeline. It converts *a box you
point at* into text. It cannot find text on a page — that is the detection model's job
(`PP-OCRv6_*_det`), which this app does not load yet.

So: one `recognize` call reads **one line of text**. Pointing it at a whole paragraph
returns garbage, because the model squashes whatever box it is given down to 48 pixels
tall and expects a single line to fill it.

## Typical flow

```
app_command loadImage   { dataUrl }                     # or the user drops/pastes one
app_command recognize   { x, y, width, height }         # one line
app_query   lastResult                                  # { text, confidence, ... }
```

To read several lines, call `recognize` once per line with a box around each.

## Commands

| Command | Params | Notes |
|---|---|---|
| `loadImage` | `{ dataUrl }` | Replaces the loaded image, clears the selection |
| `loadSample` | — | Built-in multi-script test card; good for checking the model runs |
| `setModel` | `{ modelId: 'medium' \| 'small' \| 'tiny' }` | 77 MB / 21 MB / 4.5 MB; `tiny` is Latin + Chinese only |
| `recognize` | `{ x?, y?, width?, height? }` | Omit the box to use the current selection, else the whole image |

## State

`status` (busy / message / backend / image size / selection), `lastResult`, `results`
(history, newest first), `models`.

## First call is slow

The first `recognize` downloads model weights — 4.5 MB to 77 MB depending on `modelId` —
before it can run. Use a long timeout; if the transport gives up, read the `status` state
rather than re-issuing the command. Weights are cached in IndexedDB afterwards, so later
calls start immediately and work offline.

`status.backend` says whether WebGPU is in use. On the wasm fallback recognition is
several times slower but still correct.

## Which scripts actually work

The upstream model card says "50 languages", but the shipped ONNX exports do not back
that up. Counted directly from the dictionary the models were exported with:

| Script | `medium` / `small` (18,708 chars) | `tiny` (6,904 chars) |
|---|---|---|
| Latin, digits, punctuation | yes | yes |
| Chinese (15,565 CJK ideographs) | yes | yes (6,174) |
| Japanese kana | yes | **no** |
| **Korean (Hangul)** | **no — 0 characters** | **no** |
| **Cyrillic** | **no — 0 characters** | **no** |

A line in an unsupported script does not error — it decodes to an empty string with
confidence 0, because the model has no labels to emit. If a result comes back empty on
an image that clearly has text, check the script before assuming the box was wrong.
Korean and Cyrillic need a different recognizer (PaddleOCR publishes per-language ones);
this app does not ship them.

## Accuracy notes

- `confidence` is the mean per-character probability. Below roughly 0.7, treat the text as
  a guess: usually the box was too tall, held more than one line, or clipped the glyphs.
- Give the box a little margin around the text. A box cropped tight to the glyph tops and
  bottoms reads worse than one with a few pixels of padding.
