# Image Edit

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/image-edit', {
  action: "create",
  title: "Image Edit",
  renderer: "iframe",
  content: "yaar://apps/image-edit"
})
```

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
invoke('yaar://windows/image-edit', { action: "app_query" })
```

Use `app_query` to discover available state and commands. Then query state with `invoke('yaar://windows/image-edit', { action: "app_query", stateKey: "..." })` and run commands with `invoke('yaar://windows/image-edit', { action: "app_command", command: "...", params: {...} })`.
