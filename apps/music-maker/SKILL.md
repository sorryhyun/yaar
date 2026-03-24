# Music Maker

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/music-maker', {
  action: "create",
  appId: "music-maker",
  title: "Music Maker",
  renderer: "iframe",
  content: "yaar://apps/music-maker"
})
```

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
invoke('yaar://windows/music-maker', { action: "app_query" })
```

Use `app_query` to discover available state and commands. Then query state with `invoke('yaar://windows/music-maker', { action: "app_query", stateKey: "..." })` and run commands with `invoke('yaar://windows/music-maker', { action: "app_command", command: "...", params: {...} })`.
