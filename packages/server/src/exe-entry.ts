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
import { getPort } from './config.js';
import { hideConsole } from './hide-console.js';

/**
 * Find a Chromium-based browser that supports --app mode.
 * Returns the executable path or null if not found.
 */
function findChromiumBrowser(): string | null {
  const currentPlatform = platform();

  if (currentPlatform === 'win32') {
    // Common install locations for Chrome and Edge on Windows
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

/**
 * Build the full URL, including the remote auth token when in remote/bundled mode.
 */
function getBaseUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

function getAppUrl(): string {
  const base = getBaseUrl();
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
      `--app=${url}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-features=TranslateUI',
      '--no-first-run',
    ];

    console.log(`Opening app window: ${chromium} ${args.join(' ')}`);
    const launchTime = Date.now();
    const browserProc = Bun.spawn([chromium, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    // Hide console after browser is launched
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

  // Fallback: open in default browser
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

// Wait for the server to be fully ready, then open the app window.
try {
  await ready;
  openAppWindow();
} catch (err) {
  console.error('Server failed to start:', err);
  process.exit(1);
}
