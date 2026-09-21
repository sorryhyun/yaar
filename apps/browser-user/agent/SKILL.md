# Real Browser — driving the user's live Chrome

This app talks to the user's real, running Chrome through the YAAR Bridge extension.
Every tab listed is a tab the user can see. It is **not** the `browser` app, which is a
separate server-side/headless browser meant for autonomous work with no human watching.

## Consent

Nothing is drivable by default. Each tab reports an `allowed` flag, which turns true only
once the user clicks that tab's **"Allow use"** button in the app window. That single
click grants tab-control *and* content-read for the tab's origin at once.

Until then, every action on that tab — closing, grouping, moving, clicking, typing,
scrolling, navigating, reading its text, screenshotting it — asks the user for per-origin
consent and comes back refused if they decline. When a tab is not yet `allowed`, ask the
user to allow it. Do not retry in the hope that a prompt appears per action; it does not.

YAAR's own tab can never be closed.

## Reading a tab

- `extract` returns the page text. Reach for it first when you need selectors — discover
  the structure, then click or type against it.
- `screenshot` captures the **visible** tab, so `focus` it first or you capture whatever
  else was on screen.

## Driving a tab

`click`, `type`, `scroll` and `navigate` act by CSS selector or URL. `click`, `type` and
`scroll` take `screenshot: true` to return an image of the result in the same call.

Interactions dispatch synthetic DOM events. A widget that only accepts trusted events may
not respond, and that failure is silent rather than an error.

## Managing tabs

`focus`, `close`, `group`, `move`, `track` — each takes a numeric `tabId` from the `tabs`
state key.

## Watching a tab you drive

Subscribe on the `browser-user` window with `channels: ["dialog", "navigated"]`. The
browser pushes both on its own:

- `dialog` — a page fired a native `alert`/`confirm`/`prompt` on a tab you drove. YAAR
  intercepts it, so the tab does not freeze, and you receive `{ kind, message, tabId, url }`.
- `navigated` — a tab you drove finished loading: `{ tabId, url, title }`.

**Subscribe before the click, not after.** A form submit that triggers validation answers
with a dialog, and without the subscription that is indistinguishable from a click that
did nothing.