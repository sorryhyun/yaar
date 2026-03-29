# Process Explorer

Monitor and control all running agents, windows, and browser tabs in real-time.

## Capabilities

- **Agents tab**: Lists all agents (monitor, app, ephemeral, session) with busy/idle status. Can interrupt running agents.
- **Windows tab**: Lists all open windows with renderer type, size, and lock status. Can close windows.
- **Browsers tab**: Lists all open browser tabs with URL and title. Can close tabs.
- Dashboard cards show summary counts and act as tab selectors.
- Auto-refreshes every 3 seconds.

## App Protocol

**State keys:**
- `stats` — overview with agent stats, window count, browser count
- `agents` — array of `{ id, type, busy? }`
- `windows` — array of `{ id, title, renderer, size, locked, appId? }`
- `browsers` — array of `{ id, url, title }`

**Commands:**
- `refresh` — force refresh all data
- `interruptAgent({ agentId })` — interrupt a running agent
- `closeWindow({ windowId })` — close a window
- `closeBrowser({ browserId })` — close a browser tab
