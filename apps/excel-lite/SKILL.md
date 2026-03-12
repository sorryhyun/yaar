# Excel Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/excel-lite', {
  action: "create",
  appId: "excel-lite",
  title: "Excel Lite",
  renderer: "iframe",
  content: "yaar://apps/excel-lite"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/excel-lite" })` to copy source into a sandbox for reading or editing.
