# Market Apps

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "market-apps",
  title: "Market Apps",
  renderer: "iframe",
  content: "app://market-apps"
})
```

## Source
Source code is available in `src/` directory. Use `clone(appId="market-apps")` to copy source into a sandbox for reading or editing.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ windowId: "market-apps", stateKey: "manifest" })
```

Use `app_query` with stateKey `"manifest"` to discover available state queries and commands, then use `app_query` and `app_command` to interact with the app.
