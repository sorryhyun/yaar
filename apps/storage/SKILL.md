# Storage

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "storage",
  title: "Storage",
  renderer: "iframe",
  content: "app://storage"
})
```

## Source
Source code is available in `src/` directory. Use `clone(appId="storage")` to copy source into a sandbox for reading or editing.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ windowId: "storage", stateKey: "manifest" })
```

Use `app_query` with stateKey `"manifest"` to discover available state queries and commands, then use `app_query` and `app_command` to interact with the app.
