# Proposal: WebView Hosts — YAAR in Its Own Window on Every Platform

**Status:** phases 1a and 1b implemented on macOS and released in 0.22.0 (2026-09-29); on
macOS install.sh installs `YAAR.app` (§5c). Phase 2 and later not started.
- The macOS spike (§3) was run on 2026-09-29 on macOS 26.6, and its results are measured.
- Phases 1a and 1b as built are §5a and §5b.
- Everything about Windows, Linux and Android is unverified. Claims not yet run are marked
  **(verify)**.

Today the desktop is a tab in someone else's browser:
- the Windows/macOS/Linux exe opens Chrome/Edge in `--app` mode with a throwaway profile
  (`packages/server/src/exe-entry.ts`), falling back to the default browser;
- a phone opens Chrome (`scripts/dev/termux-open-desktop.sh`), with its Google account prompts in
  the middle of YAAR's screen.

This proposal puts the desktop in a window YAAR owns, built on each OS's own WebView, behind one
small host contract.

**Decision:** the *shipped* display is the OS WebView everywhere. **Development stays on Chrome.**
`make dev`, `claude-dev`, `MOBILE=1` and headless driving all stand on CDP, and they keep it.

| Platform | Display | Engine | Server-side browser (Browser app, headless pool) |
|---|---|---|---|
| Windows | WebView2 via `webview` + `bun:ffi` | Chromium (Edge) | Edge — `lib/browser/chrome.ts` already finds it, so **no Chrome needed at all** |
| macOS | WKWebView via `webview` + `bun:ffi` | WebKit | Chrome |
| Linux | WebKitGTK via `webview` + `bun:ffi` | WebKit | Chrome/Chromium |
| Android | YAAR host APK (`android.webkit.WebView`) + server in Termux | Chromium | Termux Chromium |

---

## 1. Desktop host shape

```
yaar exe (server process)                 yaar exe --window (window process)
┌───────────────────────────┐   spawn     ┌──────────────────────────────────────┐
│ Bun server :8000          │────────────▶│ main thread: webview_run()           │
│ headless Chrome/Edge pool │             │  └ WKWebView / WebView2 / WebKitGTK  │
│                           │◀──HTTP/WS───│      http://localhost:8000           │
│ exits when window exits   │◀──exit code─│      window.yaarHost (webview_bind)  │
└───────────────────────────┘             └──────────────────────────────────────┘
```

- **Library.** [`webview/webview`](https://github.com/webview/webview) 0.12.0 is a C API over
  WebView2, WKWebView and WebKitGTK in one 4.5k-line header. It is loaded with `bun:ffi` the way
  `hide-console.ts` already loads `user32`. On macOS it builds in seconds with
  `clang++ -dynamiclib -DWEBVIEW_BUILD_SHARED … -framework WebKit -framework Cocoa` (no CMake) into
  a 118 KB dylib.
- **Its own process.** Two measured facts force this:
  - `webview_run()` blocks the calling thread, which freezes Bun's event loop.
  - On macOS, calling it from a Bun Worker **crashes the process** (a Bun `panic: Trap
    instruction`), because AppKit insists on the main thread.

  So the exe re-spawns itself as `yaar --window <url>`, and that process does nothing but own the
  window. Bridge calls come back as synchronous `webview_bind` callbacks on that thread. Anything
  heavy goes to the server over HTTP.
- **Lifecycle.** When the window process exits, the server shuts down (SIGTERM →
  `lifecycle.shutdown()`), which is today's "browser closed" rule. The per-launch temp profile and
  the "Chrome exited within 3 s, so it delegated" heuristic both go away. A window process is never
  shared, so there is no other instance to delegate to.
- **Fallback.** If the library fails to load or the platform lacks its WebView (for example, no
  WebView2 runtime), fall back to today's path: Chrome/Edge `--app`, then the default browser.
- **Vendoring.** Several gaps below are missing delegate methods in the header (downloads, new
  windows, TLS trust). Vendor `webview.h` at a pinned tag under `packages/…/native/webview/`, with
  a small YAAR patch set, rather than depending on a prebuilt binary. It is compiled in CI per
  platform and embedded in the exe, which extracts it on first run.

---

## 2. The host contract: `window.yaarHost`

One interface in `@yaar/shared` (`host-contract.ts`). Every host implements it, and the frontend
never learns which host it is in.

```ts
interface YaarHost {
  version: 1;
  platform: 'windows' | 'macos' | 'linux' | 'android';
  caps: Array<'download' | 'clipboard' | 'share' | 'openExternal' | 'insets' | 'back'>;
  download(file: { name: string; mime: string; bytes: ArrayBuffer }): Promise<{ savedTo: string }>;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  share?(data: { text?: string; url?: string; file?: { name: string; mime: string; bytes: ArrayBuffer } }): Promise<void>;
  openExternal(url: string): void;
  on(event: 'back' | 'insets', cb: (payload: unknown) => void): () => void;
}
```

- **Main frame only.** App iframes on `127.0.0.1` must never reach the host.
  - On macOS, `webview`'s bindings are injected with `forMainFrameOnly: YES` (read in the source).
  - On Android, `addWebMessageListener` takes an allowed-origin rule of `http://localhost:8000`.
  - For WebView2 and WebKitGTK **(verify)**. Checking the origin on every call costs nothing
    either way.
- **No host means today's behavior.** `lib/host.ts` exposes `getHost()`, which returns the host
  or null. Every call site keeps its current path as the fallback (`<a download>`,
  `navigator.clipboard`), so Chrome, Cromite and dev are untouched.
- **Iframe downloads.** The SDK's `downloadBlob()` runs on the app origin, which cannot reach the
  host. When the shell reports a host with `download`, the SDK posts the blob up the existing
  iframe bridge and the shell calls `yaarHost.download`.
- **Bytes.** Pass bytes as base64 over `webview_bind` (its payloads are JSON), and as an
  ArrayBuffer over Android WebMessage where the installed WebView supports it **(verify)**.

---

## 3. macOS spike results (measured 2026-09-29)

The spike ran the YAAR dev server (`LAUNCH_CHROME=0`) on macOS 26.6 with `webview` 0.12.0 via
`bun:ffi`, pointed at `http://localhost:8000/`. It used an init script for in-page checks and a
bound `__poll` eval channel for scripted steps. Window screenshots came from `screencapture -l`.

| Check | Result |
|---|---|
| Desktop renders | ✅ command palette present **320 ms** after navigation start; no page errors |
| Bundled app (Storage) | ✅ opens, lists files, renders correctly |
| User app (Crawl) | ✅ renders — but loaded **same-origin**: the desktop's own launch path never carried the app-origin marks. Fixed in phase 0 (`features/window/origin-marks.ts`); the WebKit re-run with an isolated app passed |
| Agent turn (markdown window: heading, table, code block) | ✅ created and rendered |
| WebGPU | ✅ adapter (`apple`/`apple`), `shader-f16` present, a 1M-float compute pass round-trips correctly in 59 ms |
| localStorage / sessionStorage / IndexedDB | ✅ |
| Service worker | ✅ registered and active |
| `isSecureContext` on `http://localhost` | ✅ true |
| `pointer: fine`, form factor | ✅ desktop shell |
| Clipboard write | ✅ |
| Clipboard **read** | ❌ `NotAllowedError` (agent-triggered `user.clipboard.read` fails) → bridge |
| **Blob download** (`<a download>`, as `downloadBlob()` does) | ❌ nothing saved; the header has no `WKDownloadDelegate` → patch or bridge |
| **`window.open`** | ❌ returns `null`; no `createWebViewWith` delegate → `openExternal` + patch for OAuth popups |
| Page Lifecycle `freeze` event | absent (`onfreeze` not in `document`) — presence falls back to `visibilitychange`, fine on desktop |
| Webview on a Bun Worker thread | ❌ process crash (§1) |
| Microphone (transcribe's record button), measured 2026-09-29 | ⚠️ The **first** request, from the isolated `127.0.0.1` frame, was refused with no macOS prompt, and the app showed its "access was refused" toast. A `getUserMedia` from the main frame raised the macOS microphone prompt; once allowed, the isolated frame records too. With permission granted: a cross-origin frame with `allow="microphone"` records and one without gets `NotAllowedError` (as in Chrome); webm/opus and mp4/AAC takes both record and decode again |

**Not exercised:** image23d on WebKit's WebGPU (transcribe and anima load; see below), and
window chrome (resize, minimize, full screen). The file chooser (Storage → Upload) and a
side-by-side against Chrome were checked by hand later: both fine.

**TLS on WebKit.** Chromium's `--ignore-certificate-errors-spki-list` has no WebKit equivalent,
so the h2 local socket (`http/local-tls.ts`) is unavailable. The spike ran on plain HTTP/1.1. To
get h2 back, patch in a `didReceiveAuthenticationChallenge` handler that pins the local SPKI.
The cap itself is now measured (below), so the patch is a phase 1b deliverable.

### Follow-up measurements (2026-09-29): three regressions

A second run used the same dylib against a throwaway static server: a page on `localhost` with
an iframe on `127.0.0.1`, launched three times. YAAR itself was not running, so these describe
the engine, not YAAR's behavior on it.

| Check | Result |
|---|---|
| `canvas.toDataURL('image/webp')` | ❌ returns `data:image/png` — WebKit does not encode WebP |
| Isolated frame: localStorage, IndexedDB across launches | ❌ empty on every launch (first-party localStorage and the frame's Cache API both persisted) |
| Isolated frame: storage quota | 1.9 GB, against 19.2 GB first-party |
| HTTP/1.1 connections per host | 6 concurrent (10 slow requests, peak counted server-side) |
| `foreignObject` capture via `data:` URI | ✅ draws and reads back; a `blob:` URL taints, as in Chrome |
| Isolated frame: fetch to `localhost` | ✅ carries `Origin: http://127.0.0.1:<port>`, so the origin boundary can attribute it |
| Isolated frame: WebSocket, WebGPU adapter | ✅ |
| Host binding inside the isolated frame | ✅ absent (`typeof window.__report === 'undefined'`) |

What each failure means for YAAR:

1. **Captures are mislabeled.** The capture paths ask for WebP and get PNG bytes, and the server
   stamps `image/webp` on them regardless (`handlers/window.ts`, both `__screenshot` returns).
   The same encode is assumed in `lib/uploadImage.ts`, `store/clipboard.ts`,
   `DrawingOverlay.tsx` and `captureMonitorScreenshot.ts`.
2. **Isolated apps lose their browser storage on every launch.** This costs no weight
   downloads. Every ML app keeps its weights on server disk: transcribe, ocr and image23d
   via `prefetchWeights` (`storage/apps/<id>/models/…`), and anima under
   `storage/apps/anima/weights`. `fetchWeights` on a local URL does not mirror it into
   IndexedDB. anima's own `anima-weights` IndexedDB cache is only a copy over its disk
   files, so losing it means a local re-read, not a download. Confirmed live: transcribe
   and anima both load in WKWebView. The cost that remains is that any app that keeps real
   state in IndexedDB loses it. The app guardrails already ban localStorage.
3. **Without h2 the six-connection cap is back.** That cap is the reason `http/local-tls.ts`
   exists: a few long `/api/verb` calls queue everything else behind them.

---

## 4. Per-platform notes

### Windows (WebView2)
- **Chromium flags.** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` passes them to the embedded engine
  (verify):
  - `--ignore-certificate-errors-spki-list`: keeps the h2 local TLS socket.
  - `--remote-debugging-port`: keeps **CDP on the real display**, so headless driving works
    against the shipped window.
- **Profile.** `WEBVIEW2_USER_DATA_FOLDER` gives a persistent profile.
- **Defaults cover most gaps (verify each).** WebView2's defaults already provide:
  - the download flyout, `blob:` included;
  - the native file dialog;
  - popups in a new window (OAuth works);
  - a clipboard-read permission prompt.
- **Runtime.** WebView2 ships with Windows 11 and reaches Windows 10 via Evergreen updates. A
  missing runtime falls back to `--app`.
- **Where to verify.** Nothing here can run on the macOS dev machine. The ffi and process plumbing
  is shared with macOS and verified there; only the WebView2-specific rows need a Windows box.

### Linux (WebKitGTK)
- Riskiest. WebKitGTK's WebGPU is experimental or off by default **(verify)**, and GPU compositing
  is historically weaker.
- The go/no-go is a GNOME Web (Epiphany) smoke test, which is WebKitGTK itself, repeating §3.
- Whether WebKitGTK needs the SPKI-pin TLS patch that WKWebView did (six connections per host
  without h2) is part of the same test.
- A no-go keeps Linux on Chrome `--app`. The contract makes that a per-platform choice, not a fork.

### Android (host APK + Termux)
The server stays in Termux. Termux is the agents' userland (bash, git, coreutils, curl), not just
a runner, so an APK that carried the server would be rebuilding Termux. The APK is the display
only:
- one Activity with one `android.webkit.WebView` on `http://localhost:8000/`;
- dependencies limited to `androidx.webkit` + `androidx.core`, with no Play services (F-Droid
  compatible).

Chrome and Cromite remain the fallback when the APK is not installed.

**Termux ↔ APK:**
- `termux-open-desktop.sh` prefers the APK: host APK → WebAPK → `YAAR_TERMUX_BROWSER` → Chrome →
  default browser. `native-notifications.ts` taps follow the same script.
- Tapping the APK with no server running sends Termux's `com.termux.RUN_COMMAND` to run
  `start-termux.sh`, then waits on `localhost:8000`. This needs two one-time grants, and the
  waiting screen explains them:
  - `allow-external-apps = true` in `~/.termux/termux.properties`;
  - the `com.termux.permission.RUN_COMMAND` permission.
- No Termux installed → the waiting screen says so and links to it.

**What the APK must implement** (inventory of the shell and app iframes):

| Capability | Where YAAR uses it | Host work |
|---|---|---|
| Blob downloads | `lib/exportContent.ts` (revokes the URL synchronously after `click()`); SDK `downloadBlob()` (session-logs, lab) | Bridge (§2). http(s) downloads go to `DownloadListener` → `DownloadManager`. The host saves via `MediaStore.Downloads` (no permission on API 29+). |
| File chooser | `apps/storage` `<input type=file multiple>` | `onShowFileChooser` → `ACTION_OPEN_DOCUMENT` |
| Clipboard read | `store/clipboard.ts` (agent-triggered) | Bridge → `ClipboardManager`. The focused app may read it, which Termux:API cannot do from the background on Android 10+. |
| Popups / `_blank` | market-apps GitHub OAuth (`window.open('', '_blank')` then set location), remote-control, markdown/`IframeRenderer` anchors | `setSupportMultipleWindows` + `onCreateWindow`. Non-loopback URLs go to `ACTION_VIEW`; OAuth gets a popup WebView **(verify flow)**. |
| Visibility | `useClientPresence.ts` (`visibilitychange`/`freeze`/`resume`) | Forward `onPause`/`onResume` to the WebView. Never call global `pauseTimers()`. |
| Renderer crash | — | `onRenderProcessGone` → recreate the WebView |
| Storage | localStorage, sessionStorage, IndexedDB (`yaar-ml`) | `domStorageEnabled`, `databaseEnabled` |
| Two origins | desktop `localhost`, apps `127.0.0.1` | Load `localhost`, never `127.0.0.1`. Cleartext for both via `network_security_config`; third-party cookies on. |
| Media | app frames `allow=…microphone; autoplay` | `setMediaPlaybackRequiresUserGesture(false)`. Add `onPermissionRequest` + `RECORD_AUDIO` when an app needs the mic. |
| Haptics | `navigator.vibrate` in `PhoneGestures.tsx` | `VIBRATE` permission |
| Back / insets / IME | phone shell | `OnBackPressedCallback` → the bridge's `back` event. `adjustResize`, edge-to-edge insets **(verify `env(safe-area-inset-*)` in WebView)**. |
| WebGPU | `yaar-ml` (wasm fallback exists), `three/webgpu` | **(verify)**; not blocking |

**Later, Android-only:**
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

**Build.** A Gradle project under `hosts/android/`, built on a desktop or in CI (not in Termux),
attached to GitHub releases, with `install.sh` offering the download. Use one release keystore
from the first public build, because a signature change forces users to uninstall.

---

## 5. Phasing

| Phase | Deliverable | Done when |
|---|---|---|
| **0. macOS spike, closed out** | §3; the host-independent fixes below; one WebKit run with an actually isolated app, the file chooser clicked by hand, a side-by-side against Chrome | ✅ 2026-09-29: the spike; the WebKit re-run (isolation, capture mime, transcribe recording and disk weights); the file chooser and the side-by-side, by hand |
| **1a. Desktop window, no bridge** (§5a) | Vendored `webview.h` (unpatched), `yaar --window` process, window-exit → server shutdown, exe fallback chain; an app bundle whose `Info.plist` carries `NSMicrophoneUsageDescription` (without it WKWebView exposes no `navigator.mediaDevices` at all, §5c) | `bun run build:exe:bundle:macos` opens in WKWebView; closing it stops the server; a missing dylib falls back to `--app`; the macOS microphone prompt names YAAR |
| **1b. Contract + patches** | `host-contract.ts` + `lib/host.ts`; header patches (download delegate, new-window, clipboard, and a `requestMediaCapturePermissionForOrigin:` UI-delegate method that asks macOS for access itself and grants only the two local origins); downloads and clipboard routed through the host; the TLS patch below; app permission messages that do not point at an address bar the window lacks (transcribe's refusal toast) | A day of normal use needs no Chrome window; on a fresh install, transcribe's record button raises the macOS prompt on its first press; the regression criteria below pass in WKWebView |
| **2. Windows** | The same exe on WebView2, flags via env | §3's table re-run on a Windows box, plus CDP to the display |
| **3. Linux go/no-go** | Epiphany smoke test → WebKitGTK host or stay on `--app` | A decision, recorded here |
| **4. Android host** | APK: WebView + §4 inventory + RUN_COMMAND launch | A cold tap on the icon → desktop, with Termux never opened by hand |
| **5. Android extras** | DevTools bridge, companion spike, home launcher | Each measured before it lands |

### 5a. Phase 1a as built (2026-09-29)

| Piece | Where |
|---|---|
| `webview.h` 0.12.0, byte-identical, sha256 in its README | `packages/lib/native/webview/` |
| YAAR's Cocoa additions, compiled into the same dylib: a main menu (Edit, so Cmd+C/V/X/A/Z reach the web view at all; Quit, Hide, Minimize, Close, Full Screen), a regular activation policy even inside an `LSUIElement` bundle, a frame autosave, and exit-with-parent (a kqueue proc source, so a SIGKILLed server takes its window with it) | `packages/lib/native/webview_extras.mm` |
| Universal (arm64 + x86_64) dylib, 264 KB | `scripts/build/webview-native.ts` → `dist/native/macos/libwebview.dylib` |
| FFI binding, `runWebviewWindow()` | `@yaar/lib/webview` |
| `yaar --window <url> --parent <pid>`, routed in `exe-bundle-entry.ts` before any server module loads; reports `yaar-window-opened` on stdout | `packages/server/src/desktop-window/host.ts` |
| Server side: spawn, wait up to 20 s for the line, else fall back to Chrome `--app` → default browser; window exit → SIGTERM → `lifecycle.shutdown()` | `desktop-window/launch.ts`, `exe-entry.ts` |
| Embedded in the exe (`native/` asset dir), extracted to `~/Library/Caches/YAAR/libwebview-<hash>.dylib` | `exe-assets.ts`, `desktop-window/library.ts` |
| `dist/YAAR.app` on a macOS host: `NSMicrophoneUsageDescription`, `LSUIElement` (the server process stays out of the Dock), icon, ad-hoc signature. Data in `~/Library/Application Support/YAAR`; apps shipped in `Resources/apps` and copied out per build | `scripts/build/exe-bundle.js`, `config/env.ts` (`MACOS_APP_BUNDLE`), `macos-bundle.ts` |
| Release: a `macos-latest` job builds the dylib; the Linux job embeds it with `--require-webview` (first run: v0.22.0, green) | `.github/workflows/release.yml` |
| `YAAR_WEBVIEW=0` / `YAAR_WEBVIEW_DEVTOOLS=1` / `YAAR_WEBVIEW_LIB` | `docs/reference/server_env.md` |

Verified with the built arm64 binary: the desktop renders and connects in the window; killing
the window process shuts the server down and frees the port; killing `--parent` closes the
window within 1.5 s; an unloadable library exits 3 with no "opened" line
(the fallback trigger); spawn to open is ~240 ms. By hand: the menu (Cmd+V into the
palette, Cmd+Q).

GUI-launched apps get a minimal `PATH`, and codex is looked up on `PATH` only
(`config/providers/codex.ts`), so `YAAR.app` opened from Finder finds no codex; `yaar` from a
terminal inherits the shell's. Claude is found anyway (`~/.local/bin/claude`). See
[docs/installations/mac.md](../installations/mac.md).

### 5b. Phase 1b as built (2026-09-29)

- **Contract**: `packages/shared/src/host-contract.ts`; frontend `lib/host.ts` (`getHost`, `hostWith`, `saveViaHost`). No host → every call site keeps its browser path.
- **Host adapter**: `desktop-window/host-bridge.ts` — the init script defining a frozen `window.yaarHost` (top frame, desktop origin only) over one binding, `__yaarHostInvoke`, answered synchronously on the UI thread: download → `~/Downloads` never overwriting, clipboard via NSPasteboard, openExternal for http/https/mailto only.
- **Binding gate**: webview.h injects scripts main-frame-only, but `window.webkit.messageHandlers.__webview__` is visible to every frame, and an app iframe was measured forging a binding call through it. `webview_extras.mm` wraps the header's message handler so only the top frame of the desktop origin gets through.
- **Native** (`webview_extras.mm`, a proxy that takes the UI and navigation delegate slots and forwards the rest): WKDownloadDelegate (`a[download]` incl. blob: from app iframes, `Content-Disposition: attachment`, un-showable types); new windows (off-machine http(s) → default browser, blank/loopback/blob: → a popup window with no bindings); microphone for `localhost`/`127.0.0.1` only, asking macOS first; local TLS pinned by SPKI.
- **h2**: the window loads `https://localhost:<tlsPort>`; document, resources, the WebSocket and isolated app iframes on `https://127.0.0.1:<tlsPort>` all go through the pin (12 concurrent requests in flight, measured).
- **App frames**: the device handshake carries `host: {platform, caps} | null`; `downloadBlob()` posts `yaar:download` (bytes transferred, 128 MiB cap) and the shell saves through the host.
- **⌘W**: closes the top YAAR window, not the native one. A hand check found the 1a menu's ⌘W closing the native window, and with it the desktop and the server. The Close Window item now dispatches `yaarhost:closeWindow` in the top frame (`closeKeyEvent`, `webview_extras_route_close_key`), after the page has had the keydown, and the shell answers `yaarHost.on('closeWindow')` with the same top-window rule as Ctrl+W. The red close button still quits.
- **transcribe**: the refusal message names System Settings → Privacy & Security → Microphone under a macOS host.

Verified: in a scripted harness, everything above; in the shipped window by hand, window export → host save → "Saved to …" toast.

By hand in the installed window: ⌘W closes one YAAR window per press; openExternal and the
GitHub OAuth popup work end to end.

**Service worker under the pin: not an issue.** A harness window once kept serving a shell
cached in an earlier run. The suspicion was that WebKit does not send a service worker's own
fetches through the navigation delegate's TLS challenge, so its network-first document fetch
would always fail and fall back to cache. Measured on 2026-09-29, it does send them: a
network-first worker's `fetch` reached the server over the pinned socket on two launches, and
the second launch showed the server's new version. The stale shell was `01facf81`: every exe
build ETagged `index.html` as `"index.html"`, so an upgraded exe answered revalidation with
304. That is fixed in 0.22.0.

### 5c. The installed `YAAR.app` (2026-09-29)

The first 0.22.0 install (bare binary from install.sh) opened the window, and transcribe's
record button said "Recording needs a secure page". Measured with a probe page reporting
from its top frame and a `127.0.0.1` iframe:

| Host process | `isSecureContext` | `navigator.mediaDevices` |
|---|---|---|
| bare `yaar`, pinned https or plain http; release, local and spike dylibs alike | true | **undefined** |
| the same binary inside a `.app` whose Info.plist has `NSMicrophoneUsageDescription` | true | present, `getUserMedia` too |

WKWebView gates the whole capture API on the main bundle's usage string, so the 1a note
that a bare binary "borrows the terminal's microphone grant" was wrong: it has no API to
ask with. (Why the morning spike under bare `bun` recorded is unexplained.)

So on macOS, install.sh now assembles `~/Applications/YAAR.app` itself (`APP_DIR`
overrides): the verified binary in `Contents/MacOS`, the apps archive in
`Resources/apps` with a stamp, an icon from the tag, the Info.plist, an ad-hoc
signature — all with tools every Mac has, which the Linux release runner does not.
`~/.local/bin/yaar` becomes a launcher that `exec`s the bundle's executable (a symlink
would lose the bundle). The first install over a bare one moves the data
(`config storage session_logs user-apps workspaces .env`) into
`~/Library/Application Support/YAAR`, setting aside anything already there under
`.pre-migration-<time>/`. It refuses while `yaar` runs.

- The self-updater follows the bundle: apps go to `Resources/apps` with a new stamp,
  staging and the old binary stay outside the bundle, and the bundle is re-signed
  (`features/update/installer.ts`).
- `macos-bundle-plist.test.ts` keeps install.sh's Info.plist equal to
  `exe-bundle.js`'s.

Verified against the v0.22.0 assets in a scratch `HOME`: install, migration and
set-aside, reinstall (no second migration), `codesign --verify --strict`, and the probe
through the installed launcher: `mediaDevices` and `getUserMedia` present in both frames
over the pinned https socket. The updater path was run against a copy of that bundle
with a stubbed release. By hand, from the installed bundle: transcribe's record button
raises the macOS microphone prompt.

**Regression fixes** (measured in §3, "Follow-up measurements"):

| Regression | Phase | Fix | Exit criterion |
|---|---|---|---|
| Captures are PNG bytes labeled `image/webp` | 0 ✅ | The server reads the type off the bytes and re-encodes PNG/JPEG to WebP (`captureForModel` in `@yaar/lib/image`), in both `__screenshot` returns. `uploadImage.ts` keeps the original file when the canvas did not produce WebP. `clipboard.ts` already used the blob's own type; the drawing and monitor captures travel as data URLs whose prefix is honest. | A `__screenshot` read in WKWebView returns an image whose mime matches its bytes |
| Isolated apps' localStorage and IndexedDB do not survive a launch | — | None needed for weights (§3). Why WebKit kept the Cache API but not IndexedDB is still unexplained. It only matters if an app starts keeping state there, which belongs in app storage anyway. | — |
| HTTP/1.1's six connections per host | 1b ✅ | The `didReceiveAuthenticationChallenge` patch that pins the local SPKI, so the window loads the h2 socket | The window's document is served from `https://localhost:<tlsPort>` over h2 |

**Non-goals:**
- Replacing Chrome in development or headless driving.
- Bundling the server into the APK.
- Moving the Browser app off Chromium.
- iOS.

---

## 6. Open questions

- **Should the window process own tray and menu integration?** Phase 1 has landed without
  it; undecided.
- **Remote mode.** A host could also be a remote client. The `#remote=` token lives in
  sessionStorage, which a host restart loses, so the host would need to persist it.
