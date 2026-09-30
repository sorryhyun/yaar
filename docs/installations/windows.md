# YAAR on Windows

**Source:** `install.ps1`, `scripts/build/exe-bundle.js`, `scripts/build/webview-native.ts`, `packages/server/src/exe-entry.ts`, `packages/server/src/desktop-window/launch.ts`, `packages/server/src/desktop-window/host.ts`, `packages/server/src/desktop-window/host-bridge.ts`, `packages/server/src/desktop-window/library.ts`, `packages/lib/src/webview/index.ts`, `packages/lib/src/webview/native/webview_extras_win.cc`, `packages/server/src/http/local-tls.ts`

This page is about the window `yaar.exe` shows the desktop in. To install it, see the
[README](../../README.md#install) (`install.ps1` puts `yaar.exe` and `apps/` in
`~\.local\bin`). The macOS twin of this page is [mac.md](./mac.md); the checks every host runs
are in the [WebView host proposal](../proposals/webview_host_proposal.md#1-checklist-for-a-new-host).

In short: `yaar.exe` is one binary that runs twice — once as the server, once as a native
window showing the desktop in **WebView2**, the Edge (Chromium) runtime that ships with
Windows 11 and reaches Windows 10 through Evergreen updates. YAAR ships no browser engine.

---

## What happens when you run it

```
yaar.exe                                              ← server process
  ├ listen  http://127.0.0.1:8000                     ← MCP, agents, anything plain
  ├ listen  https://127.0.0.1:8443 (h2)               ← what the window uses
  └ spawn   yaar.exe --window https://localhost:8443/ --parent <server pid> --trust-spki <pin>
       └ window process: extract webview.dll, create the WebView2 window
            └ prints "yaar-window-opened" → the server hides its console
```

1. **The server starts** and, once it is listening, spawns itself as the window. The window
   must be its own process: `webview_run()` keeps the thread it runs on for as long as the
   window is open.
2. **The window process extracts its library**, `webview.dll` (embedded in the exe), to
   `%LOCALAPPDATA%\YAAR\Cache\webview-<hash>.dll` — `dlopen` cannot read the exe's virtual
   filesystem, and the hash in the name means a new build never loads an old library.
3. **It creates the WebView2 environment** with its own profile folder,
   `%LOCALAPPDATA%\YAAR\WebView2` (cookies, localStorage, IndexedDB, cache), and opens the
   window where it was last closed.
4. **The server waits up to 20 s** for the "opened" line, then hides its console window. If
   the line never comes, it falls back (see [Fallbacks](#fallbacks)).

The desktop loads from `https://localhost:8443`; installed apps' iframes from
`https://127.0.0.1:8443`, a different origin on the same socket. Both use the local TLS
socket's self-signed certificate: when WebView2 reports it, the window accepts that one key
(its SPKI pin, `--trust-spki`) on a loopback host and nothing else. That is what gives the
window HTTP/2 instead of HTTP/1.1's six connections per host.

---

## What the window does that a browser tab doesn't

The desktop learns it is in YAAR's window from `window.yaarHost` (`platform: 'windows'`),
which exists only in the desktop's top frame:

| Feature | In the window |
|---|---|
| Downloads through the host (window export, an app's `downloadBlob()`) | Saved to `~\Downloads`, never overwriting a file (`name (1).ext`) |
| `<a download>`, attachments | WebView2's own download flyout, into `~\Downloads` |
| Clipboard read | Reads the Windows clipboard directly, with no web permission prompt |
| Links and popups | Off-machine http(s) and mailto open in your default browser; blank, loopback and `blob:` popups (OAuth) open in a popup window. A top-level navigation away from the desktop is never followed — web links go to the default browser |
| Microphone, camera | Allowed for `localhost` and `127.0.0.1` only, with no WebView2 prompt; Windows' own privacy switch still decides |
| Ctrl+W | Closes the top YAAR window, as in Chrome. WebView2 binds no close key, so the page gets it |
| Alt+F4, the close button | Quit YAAR |

Windows remembers the window's position, size and maximized state between launches
(`HKCU\Software\YAAR\WindowPlacement`).

`YAAR_WEBVIEW_DEVTOOLS=1` adds right-click → Inspect. `YAAR_WEBVIEW_CDP_PORT=<port>` serves CDP
for the window on that loopback port, so a CDP client can drive the shipped window the way dev
drives Chrome.

WebView2 is Chromium, so unlike macOS there are no engine differences to work around: WebGPU,
WebP encoding and app-frame storage behave as in Chrome.

---

## How it ends

- **Closing the window stops the server.** When the window process exits, the server runs the
  same shutdown as Ctrl-C.
- **A server that dies closes the window.** The window waits on the server's process handle
  (`--parent`), so even a killed server takes its window with it.

---

## Fallbacks

1. **YAAR's window.** Skipped when `YAAR_WEBVIEW=0`, when the exe carries no library, when
   the WebView2 runtime is missing, or when no window reports in within 20 s.
2. **Chrome or Edge in `--app` mode**, with a throwaway profile, trusting the same TLS pin
   through Chromium's SPKI flag.
3. **Your default browser**, over plain `http://localhost:8000`.

---

## Building the library

`bun scripts/build/webview-native.ts` on Windows builds `dist/native/windows/webview.dll`
(x64). It needs Visual Studio or the Build Tools with "Desktop development with C++" (found
through `vswhere`), and fetches the pinned WebView2 SDK NuGet package once, checking its hash.
`bun run build:exe` runs it and embeds the result; the release builds it on a `windows-latest`
runner. The C runtime and Microsoft's WebView2 loader are linked statically, so the DLL needs
nothing beside it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| A Chrome/Edge window opened instead of YAAR's own | No WebView2 runtime, `YAAR_WEBVIEW=0`, or the window did not report in within 20 s. The server's console output says which |
| The window opens in an odd place | Delete `HKCU\Software\YAAR\WindowPlacement` |
| An app's saved browser data is gone | It lives in `%LOCALAPPDATA%\YAAR\WebView2`; clearing that folder clears it |
