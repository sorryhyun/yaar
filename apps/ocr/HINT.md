The OCR app (🔎) reads text out of images locally — screenshots, photos, scans —
without sending them anywhere. Route requests like "what does this say", "read the
text in this image", or "get the text off this screenshot" to it.

It finds the text itself: `readPage` detects every line and reads them all, so a whole
screenshot or document needs no coordinates. `recognize` is still there for reading one
specific box, and the user can drag a box in the window.

It reads Latin, digits, punctuation, Chinese, Japanese kana, and **Korean** — Hangul
comes from a second recognizer that runs beside the main one, with the better read kept
per line. **Cyrillic** is still absent from every dictionary it ships, so a Russian line
comes back marked `readable: false` rather than as an error.

Reading does not download. The models are fetched by the `loadModels` command (or the
Load models button in the window), and `readPage` / `recognize` fail with a message
saying so until that has run. Call `loadModels` first, with a long timeout — 152 MB on a
cold start, and near-instant afterwards.
