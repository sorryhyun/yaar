# 특이점이 온다

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/thesingularity-reader', {
  action: "create",
  appId: "thesingularity-reader",
  title: "특이점이 온다",
  renderer: "iframe",
  content: "yaar://apps/thesingularity-reader"
})
```

## Source
Source code is available in `src/` directory. Use `invoke('yaar://sandbox/', { action: "clone", uri: "yaar://apps/thesingularity-reader" })` to copy source into a sandbox for reading or editing.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
invoke('yaar://windows/thesingularity-reader', { action: "app_query" })
```

Use `app_query` to discover available state and commands. Then query state with `invoke('yaar://windows/thesingularity-reader', { action: "app_query", stateKey: "..." })` and run commands with `invoke('yaar://windows/thesingularity-reader', { action: "app_command", command: "...", params: {...} })`.
