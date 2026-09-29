# Proposal: WebView Hosts — YAAR in Its Own Window on Every Platform

**Status:** draft, not implemented.
- The macOS spike (§3) was run on 2026-09-29 on macOS 26.6, and its results are measured.
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
| User app (Crawl) | ✅ renders — but loaded **same-origin**, a YAAR bug since fixed (see "Not exercised" below) |
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

**Not exercised:**
- **The isolated-app path.** Crawl was opened from its desktop icon, and that path never
  isolated anything. `launchAppWindow` (frontend `store/iframe-bridge/open-url.ts`) built its
  own `window.create` without the app-origin marks, which only an agent's create
  (`features/window/create.ts`) and a replay (`logging/window-restore.ts`) derived. So every
  installed app opened from the desktop ran same-origin with it, on every engine, until the
  next reload's snapshot marked it. Fixed in phase 0: the rule is one function
  (`features/window/origin-marks.ts`), and `/api/iframe-token` hands its answer to the
  desktop with the token. (The session log was no evidence either way: the logged create is
  rebuilt by `windowCreateAction`, which omits the marks by design.) The WebKit side still
  needs a run with an app that is actually isolated.
- **File chooser.** The header implements `runOpenPanelWithParameters`, but a scripted click cannot
  open a panel. Needs one human click (Storage → Upload).
- **Heavy ML apps** (transcribe, image23d) on WebKit's WebGPU, and window chrome (resize,
  minimize, full screen).
- **Side-by-side layout against Chrome.** Two small visual differences were seen: the command
  palette's placeholder wrapped onto two lines once a window was open, and the markdown window had
  no content padding. Either may exist in Chrome too; unconfirmed.

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
| **0. macOS spike, closed out** | §3; the host-independent fixes below; one WebKit run with an actually isolated app, the file chooser clicked by hand, a side-by-side against Chrome | The spike ✅ 2026-09-29; the WebKit re-run ✅ (isolation, capture mime, transcribe recording and disk weights). Open: the file chooser, the side-by-side |
| **1a. Desktop window, no bridge** | Vendored `webview.h` (unpatched), `yaar --window` process, window-exit → server shutdown, exe fallback chain; an app bundle whose `Info.plist` carries `NSMicrophoneUsageDescription` (launched from a terminal, the spike borrowed the terminal's microphone permission; a shipped exe has none to borrow) | `bun run build:exe:bundle:macos` opens in WKWebView; closing it stops the server; a missing dylib falls back to `--app`; the macOS microphone prompt names YAAR |
| **1b. Contract + patches** | `host-contract.ts` + `lib/host.ts`; header patches (download delegate, new-window, clipboard, and a `requestMediaCapturePermissionForOrigin:` UI-delegate method that asks macOS for access itself and grants only the two local origins); downloads and clipboard routed through the host; the TLS patch below; app permission messages that do not point at an address bar the window lacks (transcribe's refusal toast) | A day of normal use needs no Chrome window; on a fresh install, transcribe's record button raises the macOS prompt on its first press; the regression criteria below pass in WKWebView |
| **2. Windows** | The same exe on WebView2, flags via env | §3's table re-run on a Windows box, plus CDP to the display |
| **3. Linux go/no-go** | Epiphany smoke test → WebKitGTK host or stay on `--app` | A decision, recorded here |
| **4. Android host** | APK: WebView + §4 inventory + RUN_COMMAND launch | A cold tap on the icon → desktop, with Termux never opened by hand |
| **5. Android extras** | DevTools bridge, companion spike, home launcher | Each measured before it lands |

**Regression fixes** (measured in §3, "Follow-up measurements"):

| Regression | Phase | Fix | Exit criterion |
|---|---|---|---|
| Captures are PNG bytes labeled `image/webp` | 0 ✅ | The server reads the type off the bytes and re-encodes PNG/JPEG to WebP (`captureForModel` in `@yaar/lib/image`), in both `__screenshot` returns. `uploadImage.ts` keeps the original file when the canvas did not produce WebP. `clipboard.ts` already used the blob's own type; the drawing and monitor captures travel as data URLs whose prefix is honest. | A `__screenshot` read in WKWebView returns an image whose mime matches its bytes |
| Isolated apps' localStorage and IndexedDB do not survive a launch | — | None needed for weights (§3). Why WebKit kept the Cache API but not IndexedDB is still unexplained. It only matters if an app starts keeping state there, which belongs in app storage anyway. | — |
| HTTP/1.1's six connections per host | 1b | The `didReceiveAuthenticationChallenge` patch that pins the local SPKI, so the window loads the h2 socket | The window's document is served from `https://localhost:<tlsPort>` over h2 |

**Non-goals:**
- Replacing Chrome in development or headless driving.
- Bundling the server into the APK.
- Moving the Browser app off Chromium.
- iOS.

---

## 6. Open questions

- **Why was Crawl not isolated in the spike run?** Answered: the desktop's own launch path
  never carried the isolation marks (§3 "Not exercised"). Fixed; the WebKit run is still owed.
- **Is h2 worth a WebKit TLS patch?** Answered: WKWebView holds six connections per host (§3),
  so the patch is in phase 1. Whether WebKitGTK needs the same patch is part of phase 3.
- **Should the window process own tray and menu integration?** Out of scope until phase 1 lands.
- **Remote mode.** A host could also be a remote client. The `#remote=` token lives in
  sessionStorage, which a host restart loses, so the host would need to persist it.
