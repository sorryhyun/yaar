# Slides Lite

Create and present slide decks quickly.

## Features
- Slide editor (title/body/image)
- Layouts: title+body, title+image, section
- Theme picker
- Thumbnail navigation + reorder
- Present mode
- PDF export (via print dialog)
- Autosave draft in browser storage

## Usage tips
- Use **Add Slide** or **Duplicate Slide** to grow the deck.
- Use arrow keys in Present mode.
- Press **Esc** to exit Present mode.
- Press **Ctrl/Cmd+S** to save manually.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "slides-lite",
  title: "Slides Lite",
  renderer: "iframe",
  content: "/api/apps/slides-lite/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.
