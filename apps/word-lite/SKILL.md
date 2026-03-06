### State
- `html` — Current document HTML content
- `text` — Current document plain text content
- `stats` — Current text stats as { words, chars }
- `title` — Current document title
- `saveState` — Current save status label

### Commands
- `setHtml` — Replace document with HTML
  Params: { html: string }
- `setTitle` — Update document title
  Params: { title: string }
- `setText` — Replace document with plain text
  Params: { text: string }
- `appendText` — Append plain text as a new paragraph to the document
  Params: { text: string }
- `appendHtml` — Append HTML content to the end of the document without replacing existing content
  Params: { html: string }
- `setDocuments` — Replace the editor with multiple documents at once
  Params: { docs: Array<{ title?: string, text?: string, html?: string }> }
- `appendDocuments` — Append multiple documents to the current editor
  Params: { docs: Array<{ title?: string, text?: string, html?: string }> }
- `saveToStorage` — Save the current document to YAAR persistent storage
  Params: { path: string }
- `loadFromStorage` — Load one or many documents from YAAR storage
  Params: { path?: string, paths?: string[], mode?: "replace" | "append" }
- `readStorageFile` — Read one file from YAAR storage without mutating the editor
  Params: { path: string, as?: "text" | "json" | "auto" }
- `readStorageFiles` — Read multiple files from YAAR storage without mutating the editor
  Params: { paths: string[], as?: "text" | "json" | "auto" }
- `newDocument` — Clear current document to a blank paragraph
  Params: {  }
- `saveDraft` — Save current document to local draft storage
  Params: {  }
- `importFromWindow` — Import content from another open window into this document
  Params: { windowId: string, mode?: "replace" | "append", includeImage?: boolean }

## Launch
Open this app in an iframe window:
```
create({
  uri: "word-lite",
  title: "Word Lite",
  renderer: "iframe",
  content: "yaar://apps/word-lite"
})
```

## Source
Source code is available in `src/` directory. Use `clone(appId="word-lite")` to copy source into a sandbox for reading or editing.
