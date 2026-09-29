# Proposal: WebView Hosts — YAAR in Its Own Window on Every Platform

**Status:** what is left. The landed parts are documented where they live:
- macOS (phases 0, 1a, 1b) shipped in 0.22.0 and is closed out: [docs/installations/mac.md](../installations/mac.md).
- The Android host APK (phase 4, display half) is in `hosts/android/`, verified on an emulator
  and a Galaxy S25: [docs/installations/android.md](../installations/android.md).
- The host contract is `packages/shared/src/host-contract.ts`. The desktop window is
  `packages/server/src/desktop-window/`.

Not started: Windows (phase 2) and the Linux go/no-go (phase 3). Android still needs its
Termux side, its phone-only checks and a release. Claims not yet run are marked **(verify)**.

**Decision (unchanged):** the *shipped* display is the OS WebView everywhere. **Development
stays on Chrome.** `make dev`, `claude-dev`, `MOBILE=1` and headless driving all stand on CDP,
and they keep it.

| Platform | Display | Engine | State |
|---|---|---|---|
| Windows | WebView2 via `webview` + `bun:ffi` | Chromium (Edge) | not started |
| macOS | WKWebView via `webview` + `bun:ffi` | WebKit | ✅ shipped |
| Linux | WebKitGTK via `webview` + `bun:ffi`, or stay on Chrome `--app` | WebKit | undecided |
| Android | host APK (`android.webkit.WebView`) + server in Termux | Chromium | APK built; Termux side and release pending |

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

## 2. Windows (WebView2)

- **Chromium flags.** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` passes them to the embedded engine
  **(verify)**:
  - `--ignore-certificate-errors-spki-list`: keeps the h2 local TLS socket, with no native
    pin like macOS needed.
  - `--remote-debugging-port`: keeps **CDP on the real display**, so headless driving works
    against the shipped window.
- **Profile.** `WEBVIEW2_USER_DATA_FOLDER` gives a persistent profile.
- **Defaults cover most gaps (verify each).** WebView2's defaults already provide:
  - the download flyout, `blob:` included;
  - the native file dialog;
  - popups in a new window (OAuth works);
  - a clipboard-read permission prompt.
- **Main frame only (verify).** Whether `webview_bind` injects into the main frame only on
  WebView2. The binding gate in `webview_extras.mm` is Cocoa code, so Windows needs its own.
- **Library.** `scripts/build/webview-native.ts` only builds the macOS dylib. A Windows DLL
  needs MSVC or a mingw cross-compile, plus a Windows job in `release.yml`.
- **Runtime.** WebView2 ships with Windows 11 and reaches Windows 10 via Evergreen updates. A
  missing runtime falls back to `--app`.
- **Where to verify.** Nothing here runs on the macOS dev machine. A Windows 11 ARM VM (UTM)
  covers every row of §1 except the GPU ones. A `windows-latest` CI runner can run the
  scripted rows on x64.

Done when: §1 re-run on a Windows box, plus CDP to the display.

## 3. Linux (WebKitGTK) go/no-go

- Riskiest. WebKitGTK's WebGPU is experimental or off by default **(verify)**, and GPU
  compositing is historically weaker.
- The go/no-go is a GNOME Web (Epiphany) smoke test, which is WebKitGTK itself, repeating §1.
- Whether WebKitGTK needs the SPKI-pin TLS patch that WKWebView did is part of the same test.
- A VM answers the functional rows but not the GPU ones, which are the ones that decide. The
  decision needs a real Linux box with a GPU.
- A no-go keeps Linux on Chrome `--app`. The contract makes that a per-platform choice, not a
  fork.

Done when: a decision, recorded here.

## 4. Android: what is left

The APK as built is [android.md](../installations/android.md). Still to do:

**Termux side:**
- The cold start (tap the icon with no server → RUN_COMMAND runs `yaar` in a Termux session →
  the desktop) is built but unrun: the emulator has no Termux, and the phone checked has the
  Google Play Termux, which has no `RunCommandService`. That Termux is supported by hand (the
  waiting screen says to run `yaar`), not by requiring F-Droid. Still to check, on an F-Droid
  Termux: that `RUN_COMMAND_SESSION_ACTION` value `1` really keeps Termux in the background.
- Whether the Play Termux runs the server itself (`install.sh`, `make termux`) and Termux:API
  is unchecked.

**On a phone** (Galaxy S25, Android 16, WebView 153, 2026-09-29):
- WebGPU works: Adreno 8xx, `shader-f16` and `subgroups`, a compute round trip correct.
- `navigator.vibrate` returns true under the `VIBRATE` permission.
- **Insets are applied twice.** WebView 153 reports the system bars in
  `env(safe-area-inset-*)` (35 px top, 48 px bottom) although the APK already pads by them.
  `applyInsets` returns the insets unconsumed, so the WebView child sees them too. Fix: consume
  them before the WebView, then re-measure on the phone and on the emulator's WebView 124.
- **The waiting screen never comes back under an open desktop.** Once `sw.js` has cached the
  shell, a reload with no server is answered from the cache, so `onReceivedError` never fires.
  The desktop's reconnect covers it, but the path that restarts Termux is dead. Decide whether
  the app should probe `/health` on its own when the desktop loses its socket.
- Still unmeasured: bytes over WebMessage as an ArrayBuffer (`WEB_MESSAGE_ARRAY_BUFFER`)
  instead of base64, for the 128 MiB saves.

**Found on the emulator** (still so on the phone):
- **Apps built before the host field existed cannot save.** The iframe SDK is compiled into
  each app's `dist/index.html`. Memo and Anima reported `device.get()` without `host`, so
  their `downloadBlob()` takes the `<a download>` path with a `blob:` URL. macOS catches that
  natively, but Android's `DownloadListener` cannot fetch another frame's blob. Fix: rebuild
  the apps, and make the app build's staleness check include the SDK scripts, so the next
  SDK change rebuilds them by itself.

**Release:**
- Build the APK in CI and attach it to GitHub releases, with `install.sh` offering it on
  Termux.
- Use one release keystore from the first public build. A signature change forces users to
  uninstall, and the applicationId (`io.github.sorryhyun.yaar`) is permanent from then on.

Done when (phase 4): a cold tap on the icon → desktop, with Termux never opened by hand (on an
F-Droid or GitHub Termux; the Play one takes one `yaar` by hand).

**Later, Android-only (phase 5, each measured before it lands):**
- **DevTools bridge.** WebView's `webview_devtools_remote_<pid>` socket admits only root, shell,
  or its own uid (Chromium `devtools_auth.cc`, from memory — **verify**). The APK can therefore
  relay the socket to Termux with no adb. It should serve an abstract socket that checks the
  peer's uid against Termux's, never a bare loopback port. WebView targets are page-level (no
  `Target.createTarget`), so the Browser app keeps Termux Chromium.
- **Companion inside the APK (spike).** The companion tab is just a second, always-visible client
  (`features/companion/companion-tab.ts`) and needs no CDP. If a second WebView under a foreground
  service stays unthrottled and reports `visible` while backgrounded **(verify — a detached
  WebView likely reports hidden)**, it replaces a whole Termux Chromium. That would be the one real
  performance win in this proposal.
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
