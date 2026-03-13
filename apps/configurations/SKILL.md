# Configurations

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/configurations', {
  action: "create",
  appId: "configurations",
  title: "Configurations",
  renderer: "iframe",
  content: "yaar://apps/configurations"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/configurations" })` to copy source into a sandbox for reading or editing.
