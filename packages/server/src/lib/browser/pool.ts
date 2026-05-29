/**
 * HeadlessServerBrowser — a BrowserProvider backed by a private server-side Chrome.
 *
 * Lazy-launches one headless Chrome process and creates isolated tabs
 * keyed by browserId (auto-incrementing integer). Enforces a max concurrent
 * limit and auto-closes sessions idle for too long.
 *
 * Uses the system Chrome/Edge — no bundled browser binary needed. This is the
 * default provider and the correct one for headless / cloud / no-display /
 * Claude-in-Claude / eval runs. See docs/browser_substrate_proposal.md.
 *
 * (Formerly `BrowserPool` — that name is kept as an alias for back-compat.)
 *
 * All the CDP/session plumbing lives in `CdpBrowserProvider`; this class adds
 * only the launch-and-own-a-private-Chrome behavior.
 */

import { CdpBrowserProvider } from './cdp-provider.js';
import { LocalUserBrowser } from './local-user-browser.js';
import type { BrowserProvider } from './types.js';
import {
  findChrome,
  launchChrome,
  cleanupChrome,
  cleanupStaleChrome,
  writePidFile,
  type ChromeInstance,
} from './chrome.js';

export class HeadlessServerBrowser extends CdpBrowserProvider {
  private chrome: ChromeInstance | null = null;
  private initPromise: Promise<ChromeInstance> | null = null;
  private chromePath: string | null | undefined; // undefined = not checked yet

  readonly controlsUserBrowser = false;

  protected get ownsChrome(): boolean {
    return true;
  }

  protected get chromeRunning(): boolean {
    return this.chrome !== null;
  }

  /** Check if a Chrome/Edge binary is available on this system. */
  async isAvailable(): Promise<boolean> {
    if (this.chromePath === undefined) {
      this.chromePath = await findChrome();
    }
    return this.chromePath !== null;
  }

  protected async ensureChromePort(): Promise<number> {
    const instance = await this.getChrome();
    return instance.port;
  }

  /** Lazy-launch the Chrome process. */
  private async getChrome(): Promise<ChromeInstance> {
    if (this.chrome) return this.chrome;
    if (this.initPromise) return this.initPromise;

    if (this.chromePath === undefined) {
      this.chromePath = await findChrome();
    }
    if (!this.chromePath) {
      throw new Error('Chrome/Chromium not found. Set CHROME_PATH or install Chrome.');
    }

    this.initPromise = (async () => {
      await cleanupStaleChrome();
      const instance = await launchChrome(this.chromePath!);
      await writePidFile(instance);
      this.chrome = instance;
      console.log(`[browser] Chrome launched on port ${instance.port}`);
      return instance;
    })();

    return this.initPromise;
  }

  protected async releaseProcess(): Promise<void> {
    if (this.chrome) {
      await cleanupChrome(this.chrome);
      this.chrome = null;
      this.initPromise = null;
      console.log('[browser] Chrome process closed');
    }
  }
}

/**
 * Back-compat alias. `HeadlessServerBrowser` was formerly `BrowserPool`;
 * existing call sites and tests may still reference the old name.
 *
 * @deprecated Use `HeadlessServerBrowser` (or the `BrowserProvider` interface).
 */
export const BrowserPool = HeadlessServerBrowser;
export type BrowserPool = HeadlessServerBrowser;

/** Singleton provider instance. */
let provider: BrowserProvider | undefined;

/**
 * Get the active browser provider.
 *
 * Selection (Phase 2 — dev opt-in):
 *  - `YAAR_BROWSER_PROVIDER=local`    → `LocalUserBrowser` (attaches to the user's
 *    own Chrome started with `--remote-debugging-port`).
 *  - `YAAR_BROWSER_PROVIDER=headless` → `HeadlessServerBrowser` (explicit).
 *  - unset → `HeadlessServerBrowser` (the safe default everywhere).
 *
 * Full environment auto-detection (local desktop with a reachable browser vs.
 * REMOTE/headless) lands in a later phase next to the AI provider factory —
 * see docs/browser_substrate_proposal.md.
 */
export function getBrowserProvider(): BrowserProvider {
  if (provider) return provider;
  provider = createBrowserProvider();
  return provider;
}

function createBrowserProvider(): BrowserProvider {
  const choice = process.env.YAAR_BROWSER_PROVIDER?.toLowerCase();
  if (choice === 'local') {
    console.log('[browser] Using LocalUserBrowser (user Chrome via --remote-debugging-port)');
    return new LocalUserBrowser();
  }
  return new HeadlessServerBrowser();
}

/**
 * @deprecated Use `getBrowserProvider()`. Returns the active provider, which is
 * currently always a `HeadlessServerBrowser`.
 */
export function getBrowserPool(): BrowserProvider {
  return getBrowserProvider();
}
