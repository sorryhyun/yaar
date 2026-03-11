# Slides Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/slides-lite', {
  action: "create",
  appId: "slides-lite",
  title: "Slides Lite",
  renderer: "iframe",
  content: "yaar://apps/slides-lite"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/slides-lite" })` to copy source into a sandbox for reading or editing.
