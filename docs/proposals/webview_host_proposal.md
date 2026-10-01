# Proposal: WebView Hosts — YAAR in Its Own Window on Every Platform

**Status:** what is left. The landed parts are documented where they live:
- macOS (phases 0, 1a, 1b) shipped in 0.22.0 and is closed out: [docs/installations/mac.md](../installations/mac.md).
- The Android host APK (phase 4, display half) is in `hosts/android/`, verified on an emulator
  and a Galaxy S25: [docs/installations/android.md](../installations/android.md).
- Windows (phase 2) is built and verified on Windows 11 (build 26200, WebView2 154):
  [docs/installations/windows.md](../installations/windows.md). What is left of it is §2.
- The host contract is `packages/shared/src/host-contract.ts`. The desktop window is
  `packages/server/src/desktop-window/`.

Linux (phase 3) is decided: no WebView host, it stays on Chrome `--app` (§3). Android still needs two
fixes found on a phone, a full run with the server in the phone's own Termux, and a release. Claims not yet run are marked **(verify)**.

**Decision (unchanged):** the *shipped* display is the OS WebView everywhere except Linux,
which keeps Chrome `--app` (§3). **Development
stays on Chrome.** `make dev`, `claude-dev`, `MOBILE=1` and headless driving all stand on CDP,
and they keep it.

| Platform | Display | Engine | State |
|---|---|---|---|
| Windows | WebView2 via `webview` + `bun:ffi` | Chromium (Edge) | ✅ built, verified; first release pending |
| macOS | WKWebView via `webview` + `bun:ffi` | WebKit | ✅ shipped |
| Linux | Chrome `--app` (no WebView host) | Chromium | ✅ decided: no-go |
| Android | host APK (`android.webkit.WebView`) + server in Termux | Chromium | APK verified on a phone; fixes and release pending |

---

## 1. Checklist for a new host

The macOS spike (2026-09-29) is what found every gap the hosts now cover. A new host runs the
same checks, with an isolated (`source:'user'`) app open, before it ships:

| Check | Why it is here |
|---|---|
| Desktop renders; a bundled and an installed app open; an agent turn renders a window | The baseline |
| `window.yaarHost` present in the top frame, absent in the `127.0.0.1` frame, and a same-origin bundled frame's calls dropped | Main frame only. On macOS an iframe was measured forging a binding call before the native gate went in |
| Clipboard read and write | WebKit refuses `navigator.clipboard.readText` outright |
| `<a download>` of a `blob:` URL, and an app's `downloadBlob()` | WKWebView saved nothing without a download delegate |
| `window.open('', '_blank')` then an off-machine `location` (market-apps' OAuth) | `window.open` returned null on WKWebView. Google refuses embedded WebViews, so consent must reach the default browser |
| First `getUserMedia` from the isolated frame (transcribe's record button) | On macOS it was refused with no prompt, and a bare binary had no `mediaDevices` at all |
| File chooser (Storage → Upload) | — |
| `canvas.toDataURL('image/webp')` | WebKit returns PNG. The server now re-encodes by the bytes, so this is only a check |
| Isolated frame's localStorage/IndexedDB across launches | WebKit empties them on every launch (still unexplained) |
| Concurrent requests per host (h2 or not) | Six on HTTP/1.1, which is why `http/local-tls.ts` exists |
| WebGPU adapter and a compute round trip | `yaar-ml` and `three/webgpu`. The wasm fallback keeps it from blocking |
| Page Lifecycle (`visibilitychange`, `freeze`) | `useClientPresence.ts` |

---

## 2. Windows (WebView2): what is left

Built as planned, with two corrections the first run forced:

- **No command-line flags or environment variables.** webview.h creates the WebView2
  environment with a fixed profile folder (`%APPDATA%\<exe name>`) and no options, and with a
  folder passed explicitly the loader ignores `WEBVIEW2_USER_DATA_FOLDER` and
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (measured, with the variables in the real process
  environment). So `webview.cc` renames the header's one loader call to a wrapper in
  `webview_extras_win.cc`, which passes the profile folder and a real options object; the
  header stays unedited. That needs Microsoft's loader, linked statically
  (`WebView2LoaderStatic.lib`), instead of webview.h's built-in one.
- **The TLS pin is native, not `--ignore-certificate-errors-spki-list`**: WebView2's
  `ServerCertificateErrorDetected` checks the pin, loopback hosts only, as the macOS delegate
  does.

The binding gate differs from macOS by design: WebView2 raises `WebMessageReceived` for the
top-level document only (a subframe's `chrome.webview.postMessage` goes to that frame's own
event, which nothing subscribes to), so the library instead holds the top level to the desktop
origin. webview.h's binding functions *are* injected into iframes, but their calls go nowhere.

Measured on the shipped exe (2026-09-30), against §1:

| Check | Result |
|---|---|
| Desktop, a bundled app, an agent turn rendering a window | ✅ |
| `yaarHost` in the top frame only (`platform: 'windows'`); a same-origin bundled frame's binding call, and a cross-origin frame's hand-built `chrome.webview.postMessage`, both dropped | ✅ |
| Clipboard read/write through the host (UTF-8, emoji) | ✅ |
| Host download (`name (1).ext`), `<a download>` of a `blob:` | ✅ (the latter through WebView2's flyout) |
| `window.open('')` and loopback popups open; other schemes → `null`; top-level navigation off the desktop origin refused | ✅ |
| `getUserMedia` from the top frame | ✅ granted, no prompt |
| `canvas.toDataURL('image/webp')`, WebGPU adapter | ✅ WebP, adapter present |
| Isolated frame's localStorage across launches | ✅ persists (profile in `%LOCALAPPDATA%\YAAR\WebView2`) |
| Concurrent requests | ✅ h2 over the pinned local TLS socket, `wss:` included |
| CDP to the real display (`YAAR_WEBVIEW_CDP_PORT`) | ✅ |
| Window closes → server shuts down; server killed → window exits; placement remembered | ✅ |
| Ctrl+W closes the top YAAR window | ✅ over CDP input only — **a real keypress is unrun** |

**Still unrun:**
- Ctrl+W from the keyboard (above), the file chooser (Storage → Upload), and an OAuth popup
  end to end (market-apps' GitHub sign-in). Each needs a person at the window.
- `getUserMedia` from an isolated `127.0.0.1` frame (the handler grants by the requesting
  origin, so it should behave as the top frame did).
- A machine without the WebView2 runtime (a clean Windows 10): the window should refuse and
  fall back to `--app`.
- The `webview-windows` release job has not run yet; the first release is its test.

## 3. Linux: no-go, stays on Chrome `--app`

**Decided 2026-09-29.** The display on Linux stays Chrome `--app`, and no WebKitGTK host is built.

- **CDP.** Linux keeps one engine, and it is the one YAAR already drives. The Browser app and
  headless driving run Chrome over CDP on every platform. From source (`make claude-dev`), the
  window you look at is a Chrome with a DevTools port (9222), which headless driving and the
  clipboard grant attach to. A WebKitGTK window would have been a second engine with no CDP.
  The release binary's `--app` window has no DevTools port today, but adding one would take a
  flag, not a host.
- **Compute.** Models run faster on Chrome's WebGPU than on WebKit's. WKWebView has no
  `subgroups` and ran anima about 1.8× slower than Chrome on the same Mac
  ([mac_ml.md](../installations/mac_ml.md)). WebKitGTK's WebGPU was never shown to be usable
  at all.
- **Cost.** A host would have needed a GTK extras library, a web-process extension for the
  main-frame binding gate (as far as anyone checked, WebKitGTK script messages do not say which frame sent them), and
  native arm64 CI jobs. All of that would have bought a window Chrome already provides.

Nothing on Linux changes. `library.ts` has no Linux entry, so `openDesktopWindow` returns
false and `exe-entry.ts` opens Chrome/Edge as it always has. Reopen this only if Chrome
`--app` itself stops being viable on Linux.

## 4. Android: what is left

The APK as built is [android.md](../installations/android.md). Still to do:

**Still unrun:**
- Insets on the Galaxy S25. The APK now consumes them, and the emulator's WebView 124 reads
  `env(safe-area-inset-*)` as 0 on every side. Check that WebView 153 does too: no empty band
  above a maximized window or below the command sheet's handle.
- Android 10 (API 29). The insets code went through the platform's API 30 calls, which lint
  flagged and which fail `onCreate` there. It uses androidx.core's compat classes now, but there
  is no API 29 image to run it on.
- The server in the phone's own Termux. The phone checked had the Google Play Termux and no
  YAAR in it: does that Termux run `install.sh` (its Chromium step included) and `make termux`,
  and Termux:API? Does `yaar`
  there reach the app through `termux-open-desktop.sh`? Termux's own `am` was only seen to
  open the app, not its output, which `view_in` greps.
- The cold start through `RUN_COMMAND`, on an F-Droid or GitHub Termux. Check that
  `RUN_COMMAND_SESSION_ACTION` value `1` really keeps Termux in the background.
- A `VIEW` of a port other than 8000 while the app is open. `am` answered "brought to the
  front" for the same URL, so check that `onNewIntent` still receives a different one.
- Bytes over WebMessage as an ArrayBuffer (`WEB_MESSAGE_ARRAY_BUFFER`) instead of base64, for
  the 128 MiB saves.

**Release:** `release.yml` builds and signs `yaar-android.apk`, and `install.sh` offers it on
Termux ([android.md](../installations/android.md#installing-the-app)). Still to do:
- Mint the release keystore and put it in the four `ANDROID_*` secrets. Until then releases
  ship no APK. From the first APK on, the key and the applicationId
  (`io.github.sorryhyun.yaar`) are permanent.
- Run install.sh on a phone against the first release that carries the APK, with both Termux
  builds. The Play build's refusal of `termux-open` was measured, and so was Chrome getting as
  far as asking for the install permission. Nothing was installed. Also unmeasured:
  `cmd package query-services` naming `RunCommandService` on the F-Droid build, and whether
  `cmd package list packages` sees the app from either Termux.

Done when (phase 4): a cold tap on the icon → desktop, with Termux never opened by hand (on an
F-Droid or GitHub Termux; the Play one takes one `yaar` by hand).

**Later, Android-only (phase 5, each measured before it lands):**
- **DevTools bridge.** WebView's `webview_devtools_remote_<pid>` socket admits only root, shell,
  or its own uid (Chromium `devtools_auth.cc`, from memory — **verify**). The APK can therefore
  relay the socket to Termux with no adb. It should serve an abstract socket that checks the
  peer's uid against Termux's, never a bare loopback port. WebView targets are page-level (no
  `Target.createTarget`), so the Browser app keeps Termux Chromium.
- **Dropping the Termux Chromium companion.** The spike landed as something simpler than a
  second WebView: the desktop's own WebView, under a foreground service and held visible, keeps
  answering in the background ([android.md](../installations/android.md#what-happens-when-you-leave)).
  The companion is still parked, as the fallback for Chrome and for an app Android killed.
  Whether a phone that has the app can go without it (a whole Chromium, and a second live
  iframe per app window) is the open question: it needs the server to know that the app is
  the client, and something to answer while the app is not running at all.
- **Home launcher.** Add a `category.HOME` intent filter, which is the phone version of replacing
  `explorer.exe`. It needs `listApps`/`launchApp` in the contract, an escape hatch to the stock
  launcher, and a boot path.

---

## 5. Non-goals

- Replacing Chrome in development or headless driving.
- Bundling the server into the APK. Termux is the agents' userland (bash, git, coreutils,
  curl), not just a runner.
- Moving the Browser app off Chromium.
- iOS.

## 6. Open questions

- **Should the window process own tray and menu integration?** Undecided.
- **Remote mode.** A host could also be a remote client. The `#remote=` token lives in
  sessionStorage, which a host restart loses, so the host would need to persist it.
