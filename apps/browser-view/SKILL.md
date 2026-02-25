# Browser View

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "browser-view",
  title: "Browser View",
  renderer: "iframe",
  content: "/api/apps/browser-view/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ windowId: "browser-view", stateKey: "manifest" })
```

Use `app_query` with stateKey `"manifest"` to discover available state queries and commands, then use `app_query` and `app_command` to interact with the app.
