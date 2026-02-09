# Excel Lite

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "excel-lite",
  title: "Excel Lite",
  renderer: "iframe",
  content: "/api/apps/excel-lite/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_get_manifest({ windowId: "excel-lite" })
```

### Read state
```
app_query({ windowId: "excel-lite", stateKey: "cells" })
app_query({ windowId: "excel-lite", stateKey: "styles" })
app_query({ windowId: "excel-lite", stateKey: "selection" })
```

### Send commands
```
app_command({ windowId: "excel-lite", command: "setCells", params: { cells: { "A1": "Hello", "B1": "42" } } })
app_command({ windowId: "excel-lite", command: "setStyles", params: { styles: { "A1": { "bold": true } } } })
app_command({ windowId: "excel-lite", command: "selectCell", params: { ref: "A1" } })
app_command({ windowId: "excel-lite", command: "clearRange", params: { start: "A1", end: "C10" } })
app_command({ windowId: "excel-lite", command: "importWorkbook", params: { data: { cells: { "A1": "Hello" }, styles: {} } } })
```
