The OCR app (🔎) reads text out of images locally — screenshots, photos, scans —
without sending them anywhere. Route requests like "what does this say", "read the
text in this image", or "get the text off this screenshot" to it.

It also reads **other windows**: `readWindow { windowId }` screenshots any open app
window and reads it, so "what does that window say" needs no file and no coordinates.
Reach for it when a window's text is rendered rather than readable — a chart, a canvas,
an app with no protocol of its own. A markdown or component window is already text, so
read that one directly instead.

It finds the text itself: `readPage` detects every line and reads them all, so a whole
screenshot or document needs no coordinates. `recognize` is still there for reading one
specific box, and the user can drag a box in the window.

It reads Latin, digits, punctuation, Chinese, Japanese kana, and **Korean** — Hangul
comes from a second recognizer that runs beside the main one, with the better read kept
per line. **Cyrillic** is still absent from every dictionary it ships, so a Russian line
comes back marked `readable: false` rather than as an error.

Reading does not download. The models are fetched by the `loadModels` command (or the
Load models button in the window), and every read fails with a message saying so until
that has run. Call `loadModels` first, with a long timeout — 152 MB on a cold start,
kept in the app's own storage and about a second to reload afterwards.
