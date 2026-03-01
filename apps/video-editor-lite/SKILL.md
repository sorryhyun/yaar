# Video Editor Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "video-editor-lite",
  title: "Video Editor Lite",
  renderer: "iframe",
  content: "app://video-editor-lite"
})
```

## Source
Source code is available in `src/` directory. Use `clone(appId="video-editor-lite")` to copy source into a sandbox for reading or editing.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ windowId: "video-editor-lite", stateKey: "manifest" })
```

Use `app_query` with stateKey `"manifest"` to discover available state queries and commands, then use `app_query` and `app_command` to interact with the app.
