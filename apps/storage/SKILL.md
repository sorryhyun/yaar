# Storage

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/storage', {
  action: "create",
  appId: "storage",
  title: "Storage",
  renderer: "iframe",
  content: "yaar://apps/storage"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/storage" })` to copy source into a sandbox for reading or editing.
