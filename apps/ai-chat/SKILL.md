# AI Chat

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
invoke('yaar://windows/ai-chat', {
  action: "create",
  appId: "ai-chat",
  title: "AI Chat",
  renderer: "iframe",
  content: "yaar://apps/ai-chat"
})
```

## Source
Source code is available in `src/` directory. Use the devtools app to browse, edit, and compile the source.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
invoke('yaar://windows/ai-chat', { action: "app_query" })
```

Use `app_query` to discover available state and commands. Then query state with `invoke('yaar://windows/ai-chat', { action: "app_query", stateKey: "..." })` and run commands with `invoke('yaar://windows/ai-chat', { action: "app_command", command: "...", params: {...} })`.
