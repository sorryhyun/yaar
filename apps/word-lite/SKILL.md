# Word Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/word-lite', {
  action: "create",
  appId: "word-lite",
  title: "Word Lite",
  renderer: "iframe",
  content: "yaar://apps/word-lite"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/word-lite" })` to copy source into a sandbox for reading or editing.
