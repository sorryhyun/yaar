# Browser

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  uri: "browser",
  title: "Browser",
  renderer: "iframe",
  content: "yaar://apps/browser"
})
```

## Source
Source code is available in `src/` directory. Use `clone(appId="browser")` to copy source into a sandbox for reading or editing.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ uri: "browser" })
```

Use `app_query` with a bare window URI/ID to discover available state queries and commands, then use `app_query` and `app_command` with resource URIs to interact with the app.
