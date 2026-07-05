# Real Browser

To observe or manage the user's REAL Chrome tabs (the actual browser they are using, via the YAAR Bridge extension), open the "Real Browser" app and drive it via its app protocol.

- **Read** the user's live tabs before acting: `app_query` `tabs` / `activeTab` / `connected` on window `browser-user`.
- **Act** on a tab: `app_command` `focus` / `close` / `group` / `move` / `track` / `extract` on window `browser-user` (each takes a numeric `tabId`).
- Closing/grouping/moving a logged-in tab, and extracting a page's text, each ask the user for per-origin consent — expect a refusal until granted. YAAR's own tab cannot be closed.
- This is the user's ACTUAL Chrome. It is NOT the same as the "Browser" app, which is a separate server-side/headless browser for autonomous web tasks.
