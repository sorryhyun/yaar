/**
 * One native window with a WebView in it, through `bun:ffi` over the webview/webview C API.
 *
 * The library is built from `native/` beside this file by `scripts/build/webview-native.ts`;
 * where the caller finds the built file is the caller's business (`libPath`).
 *
 * {@link runWebviewWindow} **blocks the calling thread** until the window closes:
 * `webview_run()` is the platform's UI loop, so Bun's event loop does not turn while it
 * runs. It cannot move to a Worker either — on macOS AppKit insists on the main thread, and
 * a Worker call crashes the process outright; on Windows the native code is not one a
 * Worker can contain either (a fault there takes the process). So a process that opens a window does nothing
 * else: timers, promises and I/O callbacks queued before the call run only after the window
 * is gone. Talk to that process through its exit, or through the page.
 *
 * The page talks back through {@link WebviewWindowOptions.bindings}: global functions it
 * calls with JSON arguments, answered by synchronous handlers on this same thread, inside
 * the UI loop. A handler that blocks freezes the window for as long as it blocks.
 */

import { CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi';

export interface WebviewWindowOptions {
  /** Absolute path to the built library (`libwebview.dylib` on macOS, `webview.dll` on Windows). */
  libPath: string;
  url: string;
  title: string;
  /** Initial content size, used until an autosaved frame exists. */
  width: number;
  height: number;
  /** Right-click → Inspect (and Safari's Develop menu on macOS). */
  devtools?: boolean;
  /**
   * Remember the window's frame across launches under this name (macOS: the user
   * defaults; Windows: `HKCU\Software\YAAR\WindowPlacement`).
   */
  autosaveName?: string;
  /**
   * Windows: the WebView2 profile folder (cookies, storage, cache). Unset, webview.h puts
   * it in `%APPDATA%\<exe name>` — `bun.exe` from a source checkout. macOS ignores it:
   * WKWebView keeps one store per app.
   */
  dataDir?: string;
  /**
   * Windows: serve CDP for the window on this loopback port (Chromium's
   * `--remote-debugging-port`). macOS ignores it — WebKit has no CDP.
   */
  remoteDebuggingPort?: number;
  /** Close the window — and exit this process — as soon as process `pid` exits. */
  exitWithPid?: number;
  /**
   * Called once the window exists, just before the UI loop takes the thread. The last
   * point at which anything else in this process can run. Synchronous work only: nothing
   * it schedules will run until the window closes.
   */
  onOpen?: () => void;
  /** Script run at document start in the top frame of every page the window loads. */
  initScript?: string;
  /**
   * Global functions the page may call: `window[name](...args)` returns a promise of what
   * the handler returns (JSON-able; `undefined` resolves to undefined), rejected with the
   * error's message when it throws.
   */
  bindings?: Record<string, WebviewBinding>;
  /**
   * Only the top frame of this origin (`scheme://host:port`) may call bindings. Without
   * it, any top frame of the window may — never a subframe, whichever is set.
   */
  bindingOrigin?: string;
  /**
   * Save downloads here: `<a download>` (blob: included), attachment responses, and
   * anything the web view cannot display. Unset, downloads are dropped as the bare
   * WKWebView drops them (macOS), or go to WebView2's default folder (Windows).
   */
  downloadsDir?: string;
  /**
   * base64(sha256(SPKI)) — `@yaar/lib/tls`'s `spkiHash()` — of the one certificate key an
   * HTTPS server on a loopback host may present without being in the system trust store.
   * An EC P-256 key only (what `ensureSelfSignedCert` mints).
   */
  trustedLoopbackSpki?: string;
  /**
   * Make ⌘W the page's close key: instead of closing the native window, it dispatches
   * this event (a plain name, `[A-Za-z0-9:_-]+`) on the top frame's `window`. For a page
   * that is a desktop of its own windows. The close button still closes the native one.
   * On Windows WebView2 binds no close key, so Ctrl+W reaches the page as it is and this
   * only validates the name.
   */
  closeKeyEvent?: string;
}

/** A binding handler: the call's arguments in, a JSON-able result out (or a throw). */
export type WebviewBinding = (args: unknown[], native: WebviewNative) => unknown;

/** Platform services a binding handler may use, from the window's own library. */
export interface WebviewNative {
  /** The clipboard's text, or '' when it holds none. */
  readClipboardText(): string;
  writeClipboardText(text: string): void;
  /** Open an http(s) or mailto: URL in the app that owns it; false when refused. */
  openExternal(url: string): boolean;
  /** Tell the platform a file just landed in the downloads folder (the Dock bounces). */
  noteDownload(path: string): void;
}

const WEBVIEW_HINT_NONE = 0;
const WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER = 2;
const BINDING_SIGNATURE = {
  args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  returns: FFIType.void,
} as const;

function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'utf8');
}

function open(libPath: string) {
  return dlopen(libPath, {
    webview_create: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    webview_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
    webview_run: { args: [FFIType.ptr], returns: FFIType.i32 },
    webview_get_window: { args: [FFIType.ptr], returns: FFIType.ptr },
    webview_set_title: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    webview_set_size: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    webview_navigate: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    webview_init: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    webview_bind: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.function, FFIType.ptr],
      returns: FFIType.i32,
    },
    webview_return: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    webview_get_native_handle: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    webview_extras_configure: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    webview_extras_exit_with_process: { args: [FFIType.i32], returns: FFIType.i32 },
    webview_extras_attach: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    webview_extras_note_download: { args: [FFIType.ptr], returns: FFIType.void },
    webview_extras_clipboard_read_text: { args: [], returns: FFIType.ptr },
    webview_extras_clipboard_write_text: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    webview_extras_free: { args: [FFIType.ptr], returns: FFIType.void },
    webview_extras_open_external: { args: [FFIType.ptr], returns: FFIType.i32 },
    webview_extras_route_close_key: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}

type Symbols = ReturnType<typeof open>['symbols'];

function nativeServices(wv: Symbols): WebviewNative {
  return {
    readClipboardText() {
      const p = wv.webview_extras_clipboard_read_text() as Pointer | null;
      if (!p) return '';
      try {
        return new CString(p).toString();
      } finally {
        wv.webview_extras_free(p);
      }
    },
    writeClipboardText(text) {
      const bytes = Buffer.from(text, 'utf8');
      // A zero-length Buffer has no backing pointer to pass; one NUL byte, length 0.
      const arg = bytes.length ? bytes : Buffer.alloc(1);
      if (wv.webview_extras_clipboard_write_text(arg, bytes.length) !== 0) {
        throw new Error('the clipboard refused the text');
      }
    },
    openExternal(url) {
      return wv.webview_extras_open_external(cstr(url)) === 0;
    },
    noteDownload(path) {
      wv.webview_extras_note_download(cstr(path));
    },
  };
}

/**
 * Wrap a binding handler for webview_bind. The callback runs on the UI thread, inside
 * webview_run(), synchronously — so it answers (webview_return) before returning, and
 * never lets a throw cross back into native code.
 */
function bindingCallback(
  wv: Symbols,
  w: Pointer,
  handler: WebviewBinding,
  native: WebviewNative,
): JSCallback {
  return new JSCallback((id: Pointer, req: Pointer) => {
    let status = 0;
    let json: string;
    try {
      const args = JSON.parse(new CString(req).toString()) as unknown;
      const result = handler(Array.isArray(args) ? args : [], native);
      // webview_return takes JSON, or '' for undefined.
      json = result === undefined ? '' : JSON.stringify(result);
    } catch (err) {
      status = 1;
      json = JSON.stringify(err instanceof Error ? err.message : String(err));
    }
    wv.webview_return(w, id, status, cstr(json));
  }, BINDING_SIGNATURE);
}

/**
 * Windows: the profile folder and extra Chromium switches for the WebView2 environment that
 * `webview_create` is about to make (see `webview_extras_environment` in
 * `webview_extras_win.cc` — webview.h fixes both, and the loader ignores the WEBVIEW2_*
 * variables that would override them). Its own `dlopen` of the already-loaded library, so
 * the macOS library, which has no such symbol, is never asked for it.
 */
function configureWebView2(opts: WebviewWindowOptions): void {
  if (process.platform !== 'win32') return;
  const args: string[] = [];
  if (opts.remoteDebuggingPort !== undefined) {
    args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`);
  }
  if (!opts.dataDir && !args.length) return;
  const { symbols, close } = dlopen(opts.libPath, {
    webview_extras_environment: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  });
  symbols.webview_extras_environment(
    opts.dataDir ? cstr(opts.dataDir) : null,
    args.length ? cstr(args.join(' ')) : null,
  );
  close(); // the caller's handle keeps the library, and what was just set, loaded
}

/**
 * Open the window and run its UI loop until it closes.
 *
 * Throws — before any window appears — when the library does not load or the platform
 * cannot make a WebView (`webview_create` returns null, e.g. no WebView2 runtime). A caller
 * with a fallback should treat a throw as "use the fallback", not as a crash.
 */
export function runWebviewWindow(opts: WebviewWindowOptions): void {
  const { symbols: wv, close } = open(opts.libPath);
  configureWebView2(opts);
  const w = wv.webview_create(opts.devtools ? 1 : 0, null) as Pointer | null;
  if (!w) {
    close();
    throw new Error('webview_create returned null — this platform could not make a WebView');
  }

  // Held in locals until the loop ends: FFI receives raw pointers into these buffers.
  const title = cstr(opts.title);
  const url = cstr(opts.url);
  const autosave = opts.autosaveName ? cstr(opts.autosaveName) : null;

  wv.webview_set_title(w, title);
  wv.webview_set_size(w, opts.width, opts.height, WEBVIEW_HINT_NONE);
  const window = wv.webview_get_window(w); // NSWindow on macOS, HWND on Windows
  if (window) wv.webview_extras_configure(window, title, autosave);

  // Delegates and the binding gate go on before any binding or page exists: a binding
  // with no gate would be callable from app frames. The handle is the WKWebView on macOS,
  // the ICoreWebView2Controller on Windows.
  const webView = wv.webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  const bindingOrigin = opts.bindingOrigin ? cstr(opts.bindingOrigin) : null;
  const downloadsDir = opts.downloadsDir ? cstr(opts.downloadsDir) : null;
  const spki = opts.trustedLoopbackSpki ? cstr(opts.trustedLoopbackSpki) : null;
  if (!webView || wv.webview_extras_attach(webView, bindingOrigin, downloadsDir, spki) !== 0) {
    wv.webview_destroy(w);
    close();
    throw new Error('could not attach to the web view (unexpected webview.h?)');
  }

  if (opts.closeKeyEvent && wv.webview_extras_route_close_key(cstr(opts.closeKeyEvent)) !== 0) {
    wv.webview_destroy(w);
    close();
    throw new Error(`could not route the close key to ${opts.closeKeyEvent}`);
  }

  const native = nativeServices(wv);
  const callbacks: JSCallback[] = [];
  for (const [name, handler] of Object.entries(opts.bindings ?? {})) {
    const cb = bindingCallback(wv, w, handler, native);
    callbacks.push(cb);
    wv.webview_bind(w, cstr(name), cb.ptr, null);
  }
  const initScript = opts.initScript ? cstr(opts.initScript) : null;
  if (initScript) wv.webview_init(w, initScript);

  if (
    opts.exitWithPid !== undefined &&
    wv.webview_extras_exit_with_process(opts.exitWithPid) !== 0
  ) {
    wv.webview_destroy(w);
    close();
    throw new Error(`process ${opts.exitWithPid} is already gone`);
  }
  wv.webview_navigate(w, url);

  opts.onOpen?.();
  wv.webview_run(w);
  wv.webview_destroy(w);
  for (const cb of callbacks) cb.close();
  close();
  void [title, url, autosave, bindingOrigin, downloadsDir, spki, initScript];
}
