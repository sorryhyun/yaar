/**
 * Open the desktop in YAAR's own window — the server side of `host.ts`.
 *
 * Spawns this same executable as `yaar --window <url> --parent <our pid>` and waits for it
 * to report that a window exists. From then on the window *is* the app: when it exits, the
 * server shuts down, which is the rule the Chrome `--app` window has always had. Unlike
 * that window, this one is never shared with another instance, so there is no "exited
 * within 3 s, so it delegated" guess to make.
 *
 * Resolves false — and the caller falls back to Chrome/Edge — when the window never
 * appeared: no library for this platform, the platform could not make a WebView, the
 * process died first, or it said nothing for {@link OPEN_TIMEOUT_MS}.
 *
 * `YAAR_WEBVIEW=0` skips it outright.
 */

import { envFlag } from '../config/env.js';
import { createLogger } from '../observability/log.js';
import { TRUST_SPKI_FLAG, WINDOW_FLAG, WINDOW_OPENED_LINE } from './host.js';
import { hasWebviewLibrary } from './library.js';

const log = createLogger('desktop-window');

const OPEN_TIMEOUT_MS = 20_000;

/** Read `stream` until `line` appears (true) or it ends (false); keep draining after. */
async function waitForLine(stream: ReadableStream<Uint8Array>, line: string): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return false;
    seen += decoder.decode(value, { stream: true });
    if (seen.split('\n').includes(line)) break;
    seen = seen.slice(-line.length - 1);
  }
  // The window process's main thread writes to this pipe; a full pipe would block it,
  // and a blocked main thread is a frozen window. So whatever else it prints is read and
  // dropped for as long as it lives.
  void (async () => {
    try {
      while (!(await reader.read()).done) {
        /* discard */
      }
    } catch {
      /* process gone */
    }
  })();
  return true;
}

/**
 * `trustSpki`: the local TLS socket's key pin, when `url` is that socket — the window
 * trusts that one self-signed key on a loopback host and nothing else.
 */
export async function openDesktopWindow(
  url: string,
  opts: { trustSpki?: string } = {},
): Promise<boolean> {
  if (!envFlag('YAAR_WEBVIEW', true)) return false;
  if (!hasWebviewLibrary()) return false;

  const argv = [process.execPath, WINDOW_FLAG, url, '--parent', String(process.pid)];
  if (opts.trustSpki) argv.push(TRUST_SPKI_FLAG, opts.trustSpki);
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), OPEN_TIMEOUT_MS);
  });
  const opened = await Promise.race([waitForLine(proc.stdout, WINDOW_OPENED_LINE), timedOut]);
  clearTimeout(timer);

  if (!opened) {
    proc.kill();
    log.warn('desktop window did not open — falling back to a browser', {
      exitCode: proc.exitCode,
    });
    return false;
  }

  log.info('desktop window open', { pid: proc.pid });
  void proc.exited.then((code) => {
    log.info('desktop window closed — shutting down', { exitCode: code });
    // SIGTERM rather than a direct call, so lifecycle.shutdown() runs exactly as it does
    // for Ctrl-C: headless Chrome, warm providers, the session log flush.
    process.kill(process.pid, 'SIGTERM');
  });
  return true;
}
