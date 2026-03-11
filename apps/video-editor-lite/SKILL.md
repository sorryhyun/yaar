# Video Editor Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/video-editor-lite', {
  action: "create",
  appId: "video-editor-lite",
  title: "Video Editor Lite",
  renderer: "iframe",
  content: "yaar://apps/video-editor-lite"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/video-editor-lite" })` to copy source into a sandbox for reading or editing.
