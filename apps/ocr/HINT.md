The OCR app (🔎) reads text out of images locally — screenshots, photos, scans —
without sending them anywhere. Route requests like "what does this say", "read the
text in this image", or "get the text off this screenshot" to it.

It recognizes **one line of text per call** from a box you specify; it does not yet
locate text on a page. So either the user drags a box in the window, or you pass the
coordinates of a single line. For a full page of text, it is currently the wrong tool.

It reads Latin, digits, punctuation, Chinese, and Japanese kana. It has **no Korean
(Hangul) or Cyrillic** characters in its dictionary — those come back as empty text
rather than as an error, so don't route Korean or Russian images here.
