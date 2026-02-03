#!/usr/bin/env bun
/**
 * YAAR Standalone Executable Entry Point
 *
 * This file is the entry point for the bundled .exe.
 * It imports and starts the server, then auto-opens the browser.
 */

import { spawn } from 'child_process';
import { platform } from 'os';

// Import and start the server
// The server starts automatically on import
import './index.js';

// Auto-open browser after server starts
const PORT = process.env.PORT || '8000';
const URL = `http://127.0.0.1:${PORT}`;

// Wait for server to start, then open browser
setTimeout(() => {
  console.log(`Opening browser: ${URL}`);

  const currentPlatform = platform();

  try {
    if (currentPlatform === 'win32') {
      // Windows: use 'start' command
      spawn('cmd', ['/c', 'start', '', URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (currentPlatform === 'darwin') {
      // macOS: use 'open' command
      spawn('open', [URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      // Linux: use 'xdg-open' command
      spawn('xdg-open', [URL], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } catch {
    console.log(`Could not auto-open browser. Please visit: ${URL}`);
  }
}, 1500);

// Keep the process running
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
