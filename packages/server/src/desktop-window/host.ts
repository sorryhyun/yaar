/**
 * The window process: `yaar --window <url> [--parent <pid>] [--trust-spki <pin>]`.
 *
 * The exe re-spawns itself in this mode to show the desktop in a native WebView window
 * (`launch.ts` is the other side). It is its own process because the window cannot share
 * one with the server: `webview_run()` takes the thread it is called on for as long as the
 * window is open, which would stop the server's event loop dead, and on macOS AppKit
 * refuses to run anywhere but the main thread (a Worker crashes the process).
 *
 * So this process does nothing but own the window. It never boots the server —
 * `exe-bundle-entry.ts` routes here before any server module loads — and it tells the
 * server how things went through two channels only:
 *
 *  - one line on stdout, {@link WINDOW_OPENED_LINE}, once the window exists. A process
 *    that exits without printing it never showed anything, and the server falls back to
 *    Chrome/Edge;
 *  - its exit, which after that line means the user closed the window.
 *
 * `--parent` ties the window to the server's life: when that process exits — even by
 * SIGKILL — so does this one, rather than leaving a window onto a dead server.
 *
 * `--trust-spki` is the local TLS socket's key pin (`http/local-tls.ts`), which lets the
 * window load the desktop over h2 from `https://localhost:<tlsPort>` — WebKit has no
 * command-line switch for that, so the window's own delegate checks it (on Windows, the
 * web view's certificate-error event does).
 *
 * The page gets `window.yaarHost` (`host-bridge.ts`) in the top frame of the URL's
 * origin, and nowhere else.
 *
 * On Windows the window is WebView2, which is Chromium: `YAAR_WEBVIEW_CDP_PORT` serves CDP
 * for it on that loopback port, so a CDP client can drive the shipped window too.
 */

import { writeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { errMessage } from '@yaar/lib/errors';
import { runWebviewWindow } from '@yaar/lib/webview';
import { envFlag } from '../config/env.js';
import { CLOSE_KEY_EVENT, downloadsDir, hostBindings, hostInitScript } from './host-bridge.js';
import { resolveWebviewLibrary } from './library.js';

export const WINDOW_FLAG = '--window';
export const TRUST_SPKI_FLAG = '--trust-spki';
export const WINDOW_OPENED_LINE = 'yaar-window-opened';

/** Exit status for "no window was shown"; the server reads the missing line, not this. */
const EXIT_UNAVAILABLE = 3;

/** Windows: the WebView2 profile — storage, cookies, cache — kept across launches. */
function webView2DataDir(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'YAAR', 'WebView2');
}

/** `YAAR_WEBVIEW_CDP_PORT`, when it is a usable port. */
function cdpPort(): number | undefined {
  const raw = process.env.YAAR_WEBVIEW_CDP_PORT;
  const port = raw ? Number(raw) : NaN;
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  if (raw) console.error(`[yaar] ignoring YAAR_WEBVIEW_CDP_PORT=${raw}: not a port`);
  return undefined;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

export function runWindowProcess(args: string[]): never {
  const url = valueAfter(args, WINDOW_FLAG);
  if (!url) {
    console.error(`[yaar] ${WINDOW_FLAG} needs a URL`);
    process.exit(2);
  }
  const parentArg = valueAfter(args, '--parent');
  const parent = parentArg ? Number(parentArg) : undefined;
  const origin = URL.canParse(url) ? new URL(url).origin : null;
  if (!origin || origin === 'null') {
    console.error(`[yaar] ${WINDOW_FLAG} needs an http(s) URL, got ${url}`);
    process.exit(2);
  }

  const libPath = resolveWebviewLibrary();
  if (!libPath) {
    console.error(`[yaar] no WebView library for ${process.platform}`);
    process.exit(EXIT_UNAVAILABLE);
  }

  try {
    runWebviewWindow({
      libPath,
      url,
      title: 'YAAR',
      width: 1400,
      height: 900,
      devtools: envFlag('YAAR_WEBVIEW_DEVTOOLS', false),
      autosaveName: 'YAAR Desktop',
      dataDir: webView2DataDir(),
      remoteDebuggingPort: cdpPort(),
      exitWithPid: parent !== undefined && Number.isInteger(parent) ? parent : undefined,
      initScript: hostInitScript(origin),
      closeKeyEvent: CLOSE_KEY_EVENT,
      bindings: hostBindings(),
      bindingOrigin: origin,
      downloadsDir: downloadsDir(),
      trustedLoopbackSpki: valueAfter(args, TRUST_SPKI_FLAG),
      // Synchronous on purpose: from the next call on, this thread belongs to the UI loop.
      onOpen: () => writeSync(1, `${WINDOW_OPENED_LINE}\n`),
    });
  } catch (err) {
    console.error(`[yaar] could not open the desktop window: ${errMessage(err)}`);
    process.exit(EXIT_UNAVAILABLE);
  }
  process.exit(0);
}
