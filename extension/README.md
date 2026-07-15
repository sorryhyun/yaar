# YAAR Bridge (companion extension)

A small MV3 Chrome extension that connects your **everyday** browser to a running YAAR server,
making real tabs part of the YAAR OS. It dials *outward* to `ws://localhost:8000/bridge` — nothing
to relaunch, no debug flag, no second profile. If YAAR isn't running, it idles at zero cost and
keeps retrying.

## Status: Slice 5 — T3 Drive (protocol v4)

The extension **feeds** tabs (T1 Observe), **manages** them (T2 Manage), and now **reads and drives**
them (T3). It sends a versioned `hello` + live tab snapshots, and it receives:

- `command` — answered with a correlated `command-result`:
  - _manage_: `focus` / `close` / `group` / `move` (`chrome.tabs` / `chrome.tabGroups` glue),
  - _read_: `extract` (page text) / `screenshot` (PNG of the visible tab, via `chrome.scripting` /
    `chrome.tabs.captureVisibleTab`),
  - _drive_: `click` / `type` / `scroll` / `navigate` — synthetic DOM events injected via
    `chrome.scripting` (and a `chrome.tabs` URL update for `navigate`).
- `activity` — a "YAAR is touching your browser" cue: a transient pulsing pill overlay is injected
  into the target tab (and the toolbar badge flashes) so you can *see* the OS reach into your
  browser. Purely cosmetic.

Every mutation and every content read is gated **server-side** by per-origin consent, plus a
self-target refusal (YAAR's own tab can't be closed/moved). The user grants a tab in one click via
the Real Browser app's **"Allow use"** button. Nothing here is a raw agent capability — control of
your real browser is always mediated through that visible app window.

Permissions used: `tabs`, `tabGroups`, `alarms`, `scripting`, and `<all_urls>` host access (the
overlay + the read/drive injections run on whatever tab YAAR is acting on). After pulling this
update, reload the extension from `chrome://extensions` so Chrome re-grants them and picks up
protocol v4 — an older-version extension keeps working for observe/manage but the server will refuse
the read/drive verbs with a "please update the extension" message.

## Load it (unpacked, no build step)

1. Start a YAAR server locally: `make claude-dev` (serves on port 8000). Wait for
   `[banner] YAAR running at ...`.
2. Open `chrome://extensions` in your everyday Chrome.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select this `extension/` directory.
5. Watch the YAAR server logs — you should see:
   ```
   [bridge] extension connected: <id>
   [bridge] hello from Chrome <version> — protocol v1, N tabs
   [bridge] tabs update: N tabs
   ```
6. Open/close/switch tabs and you'll see more `[bridge] tabs update: ...` lines.

## Verifying the MV3 lifetime (the thing worth testing)

The one genuinely risky part of any MV3 bridge is the service worker sleeping. To sanity-check:

- Leave it connected and idle for a few minutes; the active WebSocket should keep the worker alive
  (Chrome ≥ 116). The `chrome.alarms` heartbeat reconnects if the socket ever drops.
- Inspect the worker via `chrome://extensions` → YAAR Bridge → **service worker** (Inspect) to watch
  the `[yaar-bridge]` console logs.
- Restart the YAAR server; the extension reconnects on its own — instantly on any tab activity
  (open/switch/close a tab), or within the `chrome.alarms` heartbeat (≤ 30s) if the browser is idle.
  You should **not** need to reload the extension. If it ever looks stuck, click the YAAR Bridge
  toolbar icon to force an immediate reconnect.

## Notes / TODO

- Port is hardcoded to `8000`. A configurable popup is a productization-phase item.
- Local-only for now: `ws://localhost/*`. REMOTE-mode pairing (QR/token) is a later feature.
