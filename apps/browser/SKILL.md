# Browser

Agent-controlled headless Chrome browser. The browser app agent is a specialist that navigates sites, fills forms, extracts content, and interacts with web pages via protocol commands.

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

The app agent handles all browser automation — delegate browsing tasks to it via protocol commands.
