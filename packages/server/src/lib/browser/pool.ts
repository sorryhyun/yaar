/**
 * HeadlessServerBrowser — a BrowserProvider backed by a private server-side Chrome.
 *
 * Lazy-launches one headless Chrome process and creates isolated tabs
 * keyed by browserId (auto-incrementing integer). Enforces a max concurrent
 * limit and auto-closes sessions idle for too long.
 *
 * Uses the system Chrome/Edge — no bundled browser binary needed. This is the
 * default provider and the correct one for headless / cloud / no-display /
 * Claude-in-Claude / eval runs.
 *
 * Its profile lives under `storage/.browser/profile` and is **kept** between runs,
 * so a site the user logged into in the sandbox is still logged in tomorrow — the
 * half of "sessions behave like processes" that a revived tab cannot supply on its
 * own. `YAAR_BROWSER_EPHEMERAL=1` goes back to a scratch dir wiped on shutdown.
 *
 * (Formerly `BrowserPool` — that name is kept as an alias for back-compat.)
 *
 * All the CDP/session plumbing lives in `CdpBrowserProvider`; this class adds
 * only the launch-and-own-a-private-Chrome behavior.
 */

import { join } from 'path';
import { CdpBrowserProvider } from './cdp-provider.js';
import { LocalUserBrowser } from './local-user-browser.js';
import type { BrowserProvider } from './types.js';
import { getBrowserStateDir, isEphemeralBrowserProfile } from '../../config.js';
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
      // Stale cleanup first, and that ordering is load-bearing now that the profile
      // persists: an orphaned Chrome from a crashed run still holds this directory's
      // singleton lock, and the new launch would sit there refusing to come up.
      const instance = await launchChrome(this.chromePath!, {
        ...(isEphemeralBrowserProfile()
          ? {}
          : { userDataDir: join(getBrowserStateDir(), 'profile') }),
      });
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

  /** Only report a port when our private Chrome is already up — never launch it. */
  protected async reachableChromePort(): Promise<number | null> {
    return this.chrome ? this.chrome.port : null;
  }
}

/**
 * Back-compat alias. `HeadlessServerBrowser` was formerly `BrowserPool`; the class
 * alias is still exercised by `tests/browser-pool.test.ts`.
 *
 * @deprecated Use `HeadlessServerBrowser` (or the `BrowserProvider` interface).
 */
export const BrowserPool = HeadlessServerBrowser;
export type BrowserPool = HeadlessServerBrowser;

/**
 * Two doors, two instances (Phase 2 — principal-routed browser access).
 *
 * The single env-switched singleton is gone. Instead there are two providers
 * alive at once, each bound to one entry point:
 *
 *  - `getHeadlessBrowser()` → `HeadlessServerBrowser`, reached by apps / `yaar-web`
 *    through `POST /api/browser`. A throwaway sandbox with no identity.
 *  - `getLocalBrowser()` → `LocalUserBrowser`, reached *only* by the session agent
 *    through `yaar://session/browser`. The user's real Chrome, real identity.
 *
 * The boundary is identity, not environment: lower agents physically reach a
 * *different instance*, so the user's real browser can't leak out the sandbox
 * door.
 */
let headlessProvider: HeadlessServerBrowser | undefined;
let localProvider: LocalUserBrowser | undefined;

/**
 * The headless sandbox provider — backs `POST /api/browser` (apps, `yaar-web`).
 * Hard-pinned to headless; it ignores `YAAR_BROWSER_PROVIDER` entirely (Q4).
 */
export function getHeadlessBrowser(): HeadlessServerBrowser {
  if (!headlessProvider) headlessProvider = new HeadlessServerBrowser();
  return headlessProvider;
}

/**
 * The local provider — backs `yaar://session/browser` (session agent only).
 * Auto-attaches to a debuggable Chrome whenever one is reachable; never launches
 * or kills it (`ownsChrome = false`). Callers must check `isAvailable()` and
 * error out when no local Chrome is reachable — never silently downgrade to
 * headless (a silent sandbox would lie about identity). See design §5.
 */
export function getLocalBrowser(): LocalUserBrowser {
  if (!localProvider) localProvider = new LocalUserBrowser();
  return localProvider;
}

/**
 * Force-headless opt-out: a user who never wants the agent near their real
 * browser sets `YAAR_BROWSER_PROVIDER=headless`. The env var is no longer a
 * *selector* (detection picks local automatically) — only this one kill-switch
 * survives, and it makes even the session door use the headless sandbox.
 */
export function isForceHeadless(): boolean {
  return process.env.YAAR_BROWSER_PROVIDER?.toLowerCase() === 'headless';
}

/**
 * Deprecated alias for `getHeadlessBrowser()`. The former back-compat callers
 * (availability probe, lifecycle shutdown, the `yaar://` overview count, the legacy
 * `/api/browser` route helper) have all been moved onto `getHeadlessBrowser()` directly;
 * this has no production callers left.
 *
 * @deprecated Prefer `getHeadlessBrowser()` / `getLocalBrowser()` by door.
 */
export function getBrowserProvider(): BrowserProvider {
  return getHeadlessBrowser();
}

/**
 * @deprecated Use `getHeadlessBrowser()`.
 */
export function getBrowserPool(): BrowserProvider {
  return getHeadlessBrowser();
}
