/**
 * The host contract: what a native window that shows the desktop offers the page, as
 * `window.yaarHost`.
 *
 * A *host* is the thing that owns the window the desktop runs in when that thing is YAAR's
 * own — the macOS WKWebView and Windows WebView2 windows (`packages/server/src/desktop-window/`)
 * and the Android APK (`hosts/android/`). Every host implements this one interface, and the
 * frontend never learns which host it is in. In Chrome, Cromite or dev there is no host:
 * `window.yaarHost` is undefined and every call site keeps its browser path
 * (`<a download>`, `navigator.clipboard`) — see the frontend's `lib/host.ts`.
 *
 * **Main frame only.** App iframes (on the `127.0.0.1` origin) must never reach the host;
 * a host injects it into the top frame of the desktop origin and nowhere else. An app that
 * needs a host capability asks the shell over the iframe bridge, and the shell decides.
 *
 * What each host does with it: `docs/installations/mac.md`, `docs/installations/windows.md` and
 * `docs/installations/android.md`;
 * the platforms still to come: `docs/proposals/webview_host_proposal.md`.
 */

export const YAAR_HOST_VERSION = 1;

export type YaarHostPlatform = 'windows' | 'macos' | 'linux' | 'android';

/** What a host can do. A caller checks `caps` before relying on an optional member. */
export type YaarHostCap =
  | 'download'
  | 'clipboard'
  | 'share'
  | 'openExternal'
  | 'insets'
  | 'back'
  | 'attention';

export interface YaarHostFile {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

export interface YaarHost {
  version: typeof YAAR_HOST_VERSION;
  platform: YaarHostPlatform;
  caps: YaarHostCap[];
  /** Save a file the way the platform saves downloads. Resolves with where it landed. */
  download(file: YaarHostFile): Promise<{ savedTo: string }>;
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
  share?(data: { text?: string; url?: string; file?: YaarHostFile }): Promise<void>;
  /** Open a URL outside YAAR, in the user's default browser (or the app that owns it). */
  openExternal(url: string): void;
  /**
   * Whether a person can see the window right now (`attention`).
   *
   * Only a host that keeps the page running while its window is not shown has this: the
   * Android app holds the page `visible` in the background so it goes on answering agents,
   * which leaves `document.visibilityState` unable to say that nobody is looking. This
   * says it instead, and the `attention` event says when it changes.
   */
  attended?(): Promise<boolean>;
  /**
   * Subscribe to a host event; returns the unsubscribe.
   *
   * - `closeWindow` — the platform's close key (⌘W on macOS) was pressed and nothing in
   *   the page claimed it: close the window on top, as Ctrl+W does. The host no longer
   *   closes itself on that key.
   * - `back`, `insets` — the phone's Back button and safe-area changes (Android).
   * - `attention` — `{ attended: boolean }`: the window went out of, or came back into,
   *   sight while the page kept running. See `attended`.
   */
  on(event: YaarHostEvent, cb: (payload: unknown) => void): () => void;
}

export type YaarHostEvent = 'closeWindow' | 'back' | 'insets' | 'attention';

/**
 * How a desktop host delivers `on()` events: a plain `Event` named this prefix plus the
 * event name, dispatched on the top frame's `window`, which the injected adapter listens
 * for. Not for page code — use `yaarHost.on`.
 */
export const YAAR_HOST_EVENT_PREFIX = 'yaarhost:';

/**
 * The raw binding a desktop host exposes beside `window.yaarHost`, and the only thing its
 * injected adapter calls: `window[YAAR_HOST_BINDING](op, args)` → a promise of the JSON
 * result. Webview bindings (webview/webview's `webview_bind`) carry JSON, so bytes travel
 * as base64. Not for page code — use `window.yaarHost`.
 */
export const YAAR_HOST_BINDING = '__yaarHostInvoke';

export type YaarHostOp =
  | {
      op: 'download';
      args: { name: string; mime: string; base64: string };
      result: { savedTo: string };
    }
  | { op: 'clipboard.readText'; args: Record<string, never>; result: { text: string } }
  | { op: 'clipboard.writeText'; args: { text: string }; result: Record<string, never> }
  | { op: 'openExternal'; args: { url: string }; result: Record<string, never> }
  | { op: 'attention.get'; args: Record<string, never>; result: { attended: boolean } };
