## Usage

RSS Reader is a 3-panel news reader app that fetches RSS/Atom feeds via the rss2json API.

### Panel Layout
- **Sidebar** (left): feed list with unread badges, add-feed form, refresh button
- **Article List** (middle): scrollable list of articles for the selected feed
- **Content Area** (right): full article view

All three panels have **draggable dividers** — drag the vertical bars between panels to resize. Widths persist via localStorage.

### App Protocol Commands
- `refresh` — fetch all feeds, returns `{ ok, totalUnread }`
- `markAllRead` — mark all visible articles as read
- `selectFeed` — params: `{ feedId }` — switch to a feed
- `addFeed` — params: `{ url, name? }` — add a new feed, returns `{ ok, feedId }`

### App Protocol State
- `unreadCount` — total unread articles across all feeds
- `feeds` — array of `{ id, name, url, unreadCount }`
- `articles` — current visible articles (max 50), each with `{ title, feedName, pubDate, isRead, link }`
- `selectedArticle` — currently open article or null

### Badge Updates
After a refresh, the app sends `sendInteraction({ event: 'unread_update', totalUnread: N })`.
Use `mcp__apps__set_app_badge` with the unread count to show it on the dock icon.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "rss-reader",
  title: "RSS Reader",
  renderer: "iframe",
  content: "/api/apps/rss-reader/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.

## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
```
app_query({ windowId: "rss-reader", stateKey: "manifest" })
```

Use `app_query` with stateKey `"manifest"` to discover available state queries and commands, then use `app_query` and `app_command` to interact with the app.
