/**
 * `window.yaarHost` in the desktop window: the page half (an init script) and the native
 * half (the binding it calls), implementing `@yaar/shared`'s host contract.
 *
 * The contract is typed on the page as promises of plain values; the window's library
 * carries JSON through one binding, {@link YAAR_HOST_BINDING}, as `(op, args)`. The init
 * script turns the one into the other — bytes to base64 on the way in, a rejected string
 * into an `Error` on the way out — and {@link hostBindings} answers each op on the UI
 * thread, synchronously (see `runWebviewWindow`): a small write to `~/Downloads`, a
 * pasteboard call, an `open`. Nothing here may wait on the network or the server.
 *
 * **Top frame of the desktop origin only.** Three layers, any one of which suffices:
 * webview.h injects its bindings and init scripts with `forMainFrameOnly:YES`; the
 * library drops binding calls from any other frame or origin (`bindingOrigin`, enforced
 * natively in `webview_extras.mm`); and the script below defines nothing unless it is in
 * the top frame of that origin. App iframes live on `127.0.0.1` and never see any of it —
 * they ask the shell over the iframe bridge, and the shell decides.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, extname, join } from 'path';
import {
  YAAR_HOST_BINDING,
  YAAR_HOST_EVENT_PREFIX,
  YAAR_HOST_VERSION,
  type YaarHost,
  type YaarHostCap,
  type YaarHostOp,
} from '@yaar/shared';
import type { WebviewBinding, WebviewNative } from '@yaar/lib/webview';

/** What this host offers. `share`, `insets` and `back` are phone things. */
const CAPS: YaarHostCap[] = ['download', 'clipboard', 'openExternal'];
const PLATFORM: YaarHost['platform'] = 'macos';

/**
 * The event the native ⌘W dispatches (`closeKeyEvent`), which the adapter turns into
 * `yaarHost.on('closeWindow')`. Closing the native window closes the whole desktop and,
 * with it, the server — too much for one stray keystroke.
 */
export const CLOSE_KEY_EVENT = `${YAAR_HOST_EVENT_PREFIX}closeWindow`;

/** Where both kinds of download land: the bridge's, and the web view's own. */
export function downloadsDir(): string {
  return join(homedir(), 'Downloads');
}

/**
 * The page half. Plain ES2020 in a string rather than a stringified function, because
 * the exe bundle minifies — a function's source would no longer be self-contained.
 */
export function hostInitScript(desktopOrigin: string): string {
  const config = JSON.stringify({
    origin: desktopOrigin,
    binding: YAAR_HOST_BINDING,
    eventPrefix: YAAR_HOST_EVENT_PREFIX,
    version: YAAR_HOST_VERSION,
    platform: PLATFORM,
    caps: CAPS,
  });
  return `(function () {
  'use strict';
  var C = ${config};
  if (window.top !== window || location.origin !== C.origin) return;

  function invoke(op, args) {
    var fn = window[C.binding];
    if (typeof fn !== 'function') return Promise.reject(new Error('yaarHost: binding missing'));
    return fn(op, args).catch(function (e) {
      throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
    });
  }

  function toBase64(bytes) {
    var u8 = bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (typeof u8.toBase64 === 'function') return u8.toBase64();
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  var host = {
    version: C.version,
    platform: C.platform,
    caps: C.caps.slice(),
    download: function (file) {
      return Promise.resolve().then(function () {
        return invoke('download', {
          name: String(file.name),
          mime: String(file.mime || ''),
          base64: toBase64(file.bytes),
        });
      });
    },
    clipboard: Object.freeze({
      readText: function () {
        return invoke('clipboard.readText', {}).then(function (r) { return r.text; });
      },
      writeText: function (text) {
        return invoke('clipboard.writeText', { text: String(text) }).then(function () {});
      },
    }),
    openExternal: function (url) {
      invoke('openExternal', { url: String(url) }).catch(function (e) {
        console.warn('yaarHost.openExternal:', e.message);
      });
    },
    on: function (event, cb) {
      var type = C.eventPrefix + String(event);
      var listener = function (e) { cb(e.detail); };
      window.addEventListener(type, listener);
      return function () { window.removeEventListener(type, listener); };
    },
  };
  Object.defineProperty(window, 'yaarHost', { value: Object.freeze(host), enumerable: false });
})();`;
}

/**
 * `name` made safe to use as one file name inside the downloads folder: its last path
 * segment, no control characters or colons, and no leading dots — a page does not get to
 * drop a hidden file.
 */
function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[:\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return cleaned || 'download';
}

/**
 * Write `bytes` into `dir` as `name`, or `name (1).ext`, `(2)`… — never over an existing
 * file. `wx` makes the existence check and the create one step. The same rule the native
 * side applies to the web view's own downloads (`webview_extras.mm`).
 */
export function saveUnique(dir: string, name: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const file = safeFileName(name);
  const ext = extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  for (let i = 0; i < 10_000; i++) {
    const path = join(dir, i === 0 ? file : `${stem} (${i})${ext}`);
    try {
      writeFileSync(path, bytes, { flag: 'wx' });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free name for ${file} in ${dir}`);
}

type OpArgs<K extends YaarHostOp['op']> = Extract<YaarHostOp, { op: K }>['args'];
type OpResult<K extends YaarHostOp['op']> = Extract<YaarHostOp, { op: K }>['result'];
type OpHandlers = {
  [K in YaarHostOp['op']]: (args: OpArgs<K>, native: WebviewNative) => OpResult<K>;
};

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what} must be a string`);
  return v;
}

function makeOps(dir: string): OpHandlers {
  return {
    download(args, native) {
      const bytes = Buffer.from(str(args.base64, 'base64'), 'base64');
      const savedTo = saveUnique(dir, str(args.name, 'name'), bytes);
      native.noteDownload(savedTo);
      return { savedTo };
    },
    'clipboard.readText': (_args, native) => ({ text: native.readClipboardText() }),
    'clipboard.writeText'(args, native) {
      native.writeClipboardText(str(args.text, 'text'));
      return {};
    },
    openExternal(args, native) {
      const url = str(args.url, 'url');
      const scheme = URL.canParse(url) ? new URL(url).protocol : '';
      if (!['http:', 'https:', 'mailto:'].includes(scheme)) {
        throw new Error('only http(s) and mailto: URLs open externally');
      }
      if (!native.openExternal(url)) throw new Error(`could not open ${url}`);
      return {};
    },
  };
}

/** The native half: one binding, dispatching on the op name. */
export function hostBindings(dir = downloadsDir()): Record<string, WebviewBinding> {
  const ops = makeOps(dir) as Record<string, (args: unknown, native: WebviewNative) => unknown>;
  return {
    [YAAR_HOST_BINDING]: ([op, args], native) => {
      const handler = typeof op === 'string' && Object.hasOwn(ops, op) ? ops[op] : undefined;
      if (!handler) throw new Error(`unknown host op: ${String(op)}`);
      return handler(args ?? {}, native);
    },
  };
}
