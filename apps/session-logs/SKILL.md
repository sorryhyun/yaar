# Session Logs

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/session-logs', {
  action: "create",
  appId: "session-logs",
  title: "Session Logs",
  renderer: "iframe",
  content: "yaar://apps/session-logs"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/session-logs" })` to copy source into a sandbox for reading or editing.
