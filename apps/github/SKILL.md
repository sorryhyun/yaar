# GitHub

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/github', {
  action: "create",
  title: "GitHub",
  renderer: "iframe",
  content: "yaar://apps/github"
})
```

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
invoke('yaar://windows/github', { action: "app_query" })
```

Use `app_query` to discover available state and commands. Then query state with `invoke('yaar://windows/github', { action: "app_query", stateKey: "..." })` and run commands with `invoke('yaar://windows/github', { action: "app_command", command: "...", params: {...} })`.
