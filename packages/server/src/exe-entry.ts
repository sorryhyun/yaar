#!/usr/bin/env bun
/**
 * YAAR Standalone Executable Entry Point
 *
 * This file is the entry point for the bundled .exe.
 * It imports and starts the server, then auto-opens in app mode
 * (Chrome/Edge --app flag for a standalone window without browser chrome).
 */

import { platform } from 'os';
import { existsSync } from 'fs';

// Import and start the server
// The server starts automatically on import
import './index.js';

import { getRemoteToken } from './http/auth.js';

// Auto-open browser after server starts
const PORT = process.env.PORT || '8000';
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
function getAppUrl(): string {
  const token = getRemoteToken();
  return token ? `${BASE_URL}/#remote=${token}` : BASE_URL;
}

/**
 * Launch the app in a standalone window (--app mode) or fall back to default browser.
 */
function openAppWindow() {
  const url = getAppUrl();
  const currentPlatform = platform();
  const chromium = findChromiumBrowser();

  if (chromium) {
    console.log(`Opening app window: ${chromium} --app=${url}`);
    Bun.spawn([chromium, `--app=${url}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return;
  }

  // Fallback: open in default browser
  console.log(`No Chromium browser found. Opening default browser: ${url}`);
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

/**
 * Wait for the server to be ready, then open the app window.
 */
async function waitAndOpen() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        openAppWindow();
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Timeout — try anyway
  openAppWindow();
}

waitAndOpen();

// Keep the process running
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
