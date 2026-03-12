# PDF Viewer

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/pdf-viewer', {
  action: "create",
  appId: "pdf-viewer",
  title: "PDF Viewer",
  renderer: "iframe",
  content: "yaar://apps/pdf-viewer"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/pdf-viewer" })` to copy source into a sandbox for reading or editing.
