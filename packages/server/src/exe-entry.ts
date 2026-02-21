#!/usr/bin/env bun
/**
 * YAAR Standalone Executable Entry Point
 *
 * This file is the entry point for the bundled .exe.
 * It imports and starts the server, then auto-opens in app mode
 * (Chrome/Edge --app flag for a standalone window without browser chrome).
 */

import { spawn, spawnSync } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';

// Import and start the server
// The server starts automatically on import
import './index.js';

// Auto-open browser after server starts
const PORT = process.env.PORT || '8000';
const URL = `http://127.0.0.1:${PORT}`;

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
      const result = spawnSync('which', [cmd], { stdio: 'pipe' });
      if (result.status === 0) {
        return result.stdout.toString().trim();
      }
    }
  }
  return null;
}

/**
 * Launch the app in a standalone window (--app mode) or fall back to default browser.
 */
function openAppWindow() {
  const currentPlatform = platform();
  const chromium = findChromiumBrowser();

  if (chromium) {
    console.log(`Opening app window: ${chromium} --app=${URL}`);
    spawn(chromium, [`--app=${URL}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  // Fallback: open in default browser
  console.log(`No Chromium browser found. Opening default browser: ${URL}`);
  try {
    if (currentPlatform === 'win32') {
      spawn('cmd', ['/c', 'start', '', URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (currentPlatform === 'darwin') {
      spawn('open', [URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      spawn('xdg-open', [URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } catch {
    console.log(`Could not auto-open browser. Please visit: ${URL}`);
  }
}

// Wait for server to start, then open app window
setTimeout(openAppWindow, 1500);

// Keep the process running
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
