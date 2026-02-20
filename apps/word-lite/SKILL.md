Word Lite is a rich-text editor with AI protocol support.

## Commands
- `setHtml` — Replace entire document with HTML
- `appendHtml` — Append HTML to end of document (preserves existing content)
- `appendText` — Append plain text as a new paragraph (preserves existing HTML)
- `setText` — Replace document with plain text
- `setTitle` — Set document title
- `newDocument` — Clear to blank document
- `saveDraft` — Save to local draft (localStorage)
- `saveToStorage` — Save to YAAR persistent storage. Params: `{ path: string }` e.g. `"docs/report.html"`
- `loadFromStorage` — Load from YAAR persistent storage. Params: `{ path: string }`

## State
- `html` — Current document HTML
- `text` — Current document plain text
- `stats` — `{ words, chars }`
- `title` — Document title
- `saveState` — Save status label

## Tips
- Use `appendHtml` to incrementally build large documents section by section (avoids large payload issues with `setHtml`)
- Use `saveToStorage` to persist documents across sessions and share with other apps

## Launch
Open this app in an iframe window:
```
create({
  windowId: "word-lite",
  title: "Word Lite",
  renderer: "iframe",
  content: "/api/apps/word-lite/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.
