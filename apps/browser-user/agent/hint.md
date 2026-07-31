# Real Browser

To observe or manage the user's REAL Chrome tabs (the actual browser they are using, via the YAAR Bridge extension), open the "Real Browser" app and drive it via its app protocol.

- **Read** the user's live tabs before acting: `app_query` `tabs` / `activeTab` / `connected` on window `browser-user`. Each tab reports `allowed` — true once the user has granted the agent full use of it.
- **Manage** a tab: `app_command` `focus` / `close` / `group` / `move` / `track` on window `browser-user` (each takes a numeric `tabId`).
- **Read** a tab: `extract` (page text) or `screenshot` (PNG of the visible tab — `focus` it first).
- **Drive** a tab: `click` (`selector`), `type` (`selector`, `text`, optional `submit`), `scroll` (`selector` | `deltaY` | `top`), `navigate` (`url`). Prefer `extract` first to discover selectors, then click/type. Interactions use synthetic DOM events — reliable on most sites, though a few trusted-event-gated widgets may not respond.
- **Watch** a tab you are driving: `app_subscribe` on window `browser-user` with `channels: ["dialog", "navigated"]`. The real browser pushes these on its own — `dialog` when a page fires a native `alert`/`confirm`/`prompt` on a tab you drove (YAAR intercepts it, so the tab does not freeze, and you get `{ kind, message, tabId, url }`), and `navigated` when a tab you drove finishes loading (`{ tabId, url, title }`). Subscribe *before* a click that might submit a form or trigger validation — otherwise a page that answers with an alert looks to you like a click that silently did nothing.
- To drive a tab, the user must first grant use by clicking that tab's **"Allow use"** button in the app — it grants tab-control + content-read for that origin at once. If a tab isn't `allowed` yet, ask the user to allow it rather than expecting a prompt per action.
- Closing/grouping/moving/clicking/typing/scrolling/navigating a logged-in tab, and reading its text or screenshot, each ask the user for per-origin consent — expect a refusal until granted (or until the tab is `allowed`). YAAR's own tab cannot be closed.
- This is the user's ACTUAL Chrome. It is NOT the same as the "Browser" app, which is a separate server-side/headless browser for autonomous web tasks.
