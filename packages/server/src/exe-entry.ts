#!/usr/bin/env bun
/**
 * YAAR Standalone Executable Entry Point
 *
 * This file is the entry point for the bundled .exe.
 * It imports and starts the server, then auto-opens in app mode
 * (Chrome/Edge --app flag for a standalone window without browser chrome).
 */

import { platform, tmpdir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Import and start the server — `ready` resolves when the server is listening
import { ready } from './main.js';

import { getRemoteToken } from './http/auth.js';
import { getLocalTlsEndpoint } from './http/local-tls.js';
import { getPort } from './config.js';
import { LINUX_WEBGPU_FLAGS } from './lib/browser/webgpu-flags.js';
import { hideConsole } from './hide-console.js';

/**
 * Find a Chromium-based browser that supports --app mode.
 * Returns the executable path or null if not found.
 */
function findChromiumBrowser(): string | null {
  const currentPlatform = platform();

  if (currentPlatform === 'win32') {
    const candidates = [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    for (const path of candidates) {
      if (path && existsSync(path)) return path;
    }
  } else if (currentPlatform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
  } else {
    // Linux: check via `which`
    for (const cmd of [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
    ]) {
      const result = Bun.spawnSync(['which', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
    }
  }
  return null;
}

function getBaseUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

function getAppUrl(base = getBaseUrl()): string {
  const token = getRemoteToken();
  return token ? `${base}/#remote=${token}` : base;
}

/**
 * Launch the app in a standalone window (--app mode) or fall back to default browser.
 */
function openAppWindow() {
  const url = getAppUrl();
  const currentPlatform = platform();
  const chromium = findChromiumBrowser();

  if (chromium) {
    // The Chromium we launch can trust the local TLS socket's leaf key by its
    // SPKI, so it gets h2 instead of HTTP/1.1's six connections per host (see
    // http/local-tls.ts). The default-browser fallback below cannot, so it keeps HTTP.
    const tls = getLocalTlsEndpoint();
    const appUrl = tls ? getAppUrl(`https://localhost:${tls.port}`) : url;
    // Use a unique user-data-dir per launch so Chrome always starts a fresh
    // process.  A shared profile causes Chrome to delegate to the already-
    // running instance and exit immediately, which triggers the shutdown handler.
    const userDataDir = join(tmpdir(), `yaar-chrome-${Date.now()}`);
    try {
      mkdirSync(userDataDir, { recursive: true });
    } catch {
      /* ignore */
    }

    const args = [
      `--app=${appUrl}`,
      // The SPKI flag is on Chrome's bad-flags list; --test-type is what skips the
      // "unsupported command-line flag" infobar it would otherwise bring (see
      // AddInfoBarsIfNecessary in chrome/browser/ui/startup/infobar_utils.cc).
      ...(tls ? [`--ignore-certificate-errors-spki-list=${tls.spki}`, '--test-type'] : []),
      `--user-data-dir=${userDataDir}`,
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-features=TranslateUI',
      '--no-first-run',
      // Without these, `yaar` and `make claude-dev` disagree about whether WebGPU
      // exists — same machine, same GPU, same app — because dev/start.sh passes them and
      // this launcher did not. Linux only; see webgpu-flags.ts. The visible-window
      // set: the headless pool's extra flags would disable the surface this window
      // presents through.
      ...(currentPlatform === 'linux' ? LINUX_WEBGPU_FLAGS : []),
    ];

    console.log(`Opening app window: ${chromium} ${args.join(' ')}`);
    const launchTime = Date.now();
    const browserProc = Bun.spawn([chromium, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    hideConsole();

    // Terminate the server when the browser window is closed.
    // Guard against Chrome exiting immediately (e.g. delegating to an
    // already-running instance) — if it exits within 3 seconds, keep
    // the server alive instead of shutting down.
    browserProc.exited.then(() => {
      const elapsed = Date.now() - launchTime;
      if (elapsed < 3000) {
        console.log(
          `Browser process exited after ${elapsed}ms — likely delegated to existing instance. Server will keep running.`,
        );
        return;
      }
      console.log('Browser closed — shutting down.');
      // Trigger graceful shutdown via SIGTERM so lifecycle.shutdown() runs,
      // which cleans up headless Chrome, warm providers, etc.
      process.kill(process.pid, 'SIGTERM');
    });
    return;
  }

  console.log(`No Chromium browser found. Opening default browser: ${url}`);
  hideConsole();
  try {
    if (currentPlatform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', '', url], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } else if (currentPlatform === 'darwin') {
      Bun.spawn(['open', url], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } else {
      Bun.spawn(['xdg-open', url], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
  } catch {
    console.log(`Could not auto-open browser. Please visit: ${url}`);
  }
}

// main.ts registers SIGINT/SIGTERM handlers for graceful shutdown.
// lifecycle.ts has a 5-second force-kill timer as a last resort.

// `.then`, not a top-level `await`: this file is the exe's entry and the exe is built
// with `--bytecode`, which emits CommonJS — where top-level `await` is a syntax error.
// A throw from `openAppWindow()` still lands in the `catch`, as it did inside the `try`.
void ready.then(openAppWindow).catch((err: unknown) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
