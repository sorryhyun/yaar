# YAAR Bridge (companion extension)

A small MV3 Chrome extension that connects your **everyday** browser to a running YAAR server,
making real tabs part of the YAAR OS. It dials *outward* to `ws://localhost:8000/bridge` — nothing
to relaunch, no debug flag, no second profile. If YAAR isn't running, it idles at zero cost and
keeps retrying.

Spec: [`../docs/extension_bridge_proposal.md`](../docs/extension_bridge_proposal.md).
Build plan: [`../0607plan.md`](../0607plan.md).

## Status: Slice 0 — bare transport

This build only proves the cable is stable. It sends a versioned `hello` and the tab count/list; the
server logs the connection. **No page-content access, no tab management, no actuation yet** — those
are Slices 1 and 2.

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
- Restart the YAAR server; the extension should reconnect within the backoff window (≤ 30s).

## Notes / TODO

- Port is hardcoded to `8000`. A configurable popup is a productization-phase item.
- Local-only for now: `ws://localhost/*`. REMOTE-mode pairing (QR/token) is a later feature.
