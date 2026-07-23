The OCR app (🔎) reads text out of images locally — screenshots, photos, scans —
without sending them anywhere. Route requests like "what does this say", "read the
text in this image", or "get the text off this screenshot" to it.

It finds the text itself: `readPage` detects every line and reads them all, so a whole
screenshot or document needs no coordinates. `recognize` is still there for reading one
specific box, and the user can drag a box in the window.

It reads Latin, digits, punctuation, Chinese, and Japanese kana. It has **no Korean
(Hangul) or Cyrillic** characters in its dictionary — those lines come back marked
`readable: false` rather than as an error, so don't route Korean or Russian images here.
