# Market Apps

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/market-apps', {
  action: "create",
  appId: "market-apps",
  title: "Market Apps",
  renderer: "iframe",
  content: "yaar://apps/market-apps"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/market-apps" })` to copy source into a sandbox for reading or editing.
