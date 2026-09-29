/**
 * HeadlessServerBrowser — a BrowserProvider backed by a private server-side Chrome.
 *
 * Lazy-launches one headless Chrome process and opens tabs — one shared profile and
 * cookie jar, not separate browser contexts — keyed by browserId (auto-incrementing integer). Enforces a max concurrent
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
 * (Formerly `BrowserPool`.)
 *
 * All the CDP/session plumbing lives in `CdpBrowserProvider`; this class adds
 * only the launch-and-own-a-private-Chrome behavior.
 */

import { rm } from 'fs/promises';
import { join } from 'path';
import { CdpBrowserProvider } from './cdp-provider.js';
import { fetchBrowserWsUrl } from './cdp.js';
import { LocalUserBrowser } from './local-user-browser.js';
import { getBrowserStateDir, isEphemeralBrowserProfile } from '../../config.js';
import {
  findChrome,
  launchChrome,
  cleanupChrome,
  cleanupStaleChrome,
  writePidFile,
  type ChromeInstance,
} from './chrome.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('browser');

/** Whether a DevTools endpoint still answers. A dead Chrome refuses the connection at once. */
async function endpointAnswers(port: number): Promise<boolean> {
  try {
    return (await fetchBrowserWsUrl(port, 1500)) !== null;
  } catch {
    return false;
  }
}

export class HeadlessServerBrowser extends CdpBrowserProvider {
  private chrome: ChromeInstance | null = null;
  private initPromise: Promise<ChromeInstance> | null = null;
  private chromePath: string | null | undefined; // undefined = not checked yet
  /**
   * Set by {@link shutdown}, and final. From here on a Chrome going away is the server
   * going away — not a crash to relaunch from — and a launch already in flight is
   * released as soon as it lands rather than left running with nothing tracking it.
   */
  private stopped = false;

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
    if (this.stopped) throw new Error('The sandbox browser is shutting down.');

    // initPromise is claimed before the first await: every caller that arrives while the
    // binary lookup is still pending joins this launch instead of starting its own, which
    // would leave all but the last Chrome running with nothing tracking its PID.
    this.initPromise = (async () => {
      if (this.chromePath === undefined) {
        this.chromePath = await findChrome();
      }
      if (!this.chromePath) {
        throw new Error('Chrome/Chromium not found. Set CHROME_PATH or install Chrome.');
      }
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
      if (this.stopped) {
        // The server began exiting while this launch was in flight.
        await cleanupChrome(instance);
        throw new Error('The sandbox browser is shutting down.');
      }
      this.chrome = instance;
      this.watchProcess(instance);
      log.info('Chrome launched', { port: instance.port });
      return instance;
    })();
    // A failed launch must not be cached: the next caller gets a fresh attempt.
    this.initPromise.catch(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  protected async releaseProcess(): Promise<void> {
    const instance = this.chrome;
    if (instance) {
      // Cleared before the kill: the exit it causes is ours, not a crash (see watchProcess).
      this.chrome = null;
      this.initPromise = null;
      await cleanupChrome(instance);
      log.info('Chrome process closed');
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await super.shutdown();
  }

  /**
   * Notice Chrome dying on its own — an OOM kill, a GPU crash, a user's `kill`.
   *
   * Without this nothing ever cleared `chrome`: every tab's socket dropped, each crash
   * restart was handed the dead instance's port, and every later session was opened
   * against it too, until the server restarted.
   *
   * On Windows the process we spawned can be a launcher that forks the real browser and
   * exits (see `launchChrome`), so an exit there only counts once the endpoint has
   * stopped answering too; the browser-level socket ({@link browserSocketLost}) covers
   * the real browser dying later.
   */
  private watchProcess(instance: ChromeInstance): void {
    void instance.process.exited?.then(async (code) => {
      if (this.chrome !== instance) return; // released on purpose, or already replaced
      if (process.platform === 'win32' && (await endpointAnswers(instance.port))) return;
      this.chromeLost(instance, `process exited (code ${code})`);
    });
  }

  /** Confirm the current Chrome is still there; if it is not, say so. */
  private async verifyChrome(): Promise<void> {
    const instance = this.chrome;
    if (!instance) return;
    if (await endpointAnswers(instance.port)) return;
    this.chromeLost(instance, 'DevTools endpoint stopped answering');
  }

  private chromeLost(instance: ChromeInstance, reason: string): void {
    if (this.chrome !== instance) return;
    this.chrome = null;
    this.initPromise = null;
    if (this.stopped) return;
    log.warn('Chrome went away — relaunching for its sessions', { port: instance.port, reason });
    // A Chrome that stopped answering may still be alive and holding the profile lock
    // the relaunch needs; one that exited makes this a no-op.
    try {
      instance.process.kill();
    } catch {
      /* already gone */
    }
    if (instance.ephemeral) {
      void rm(instance.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    this.endpointLost();
  }

  /**
   * A crash-restart's port: the current Chrome if it still answers, else a fresh one.
   * The check is what makes "Chrome itself is gone" reachable when a tab's socket
   * reports the crash before the process exit is seen.
   */
  protected async restartPort(): Promise<number | null> {
    if (this.stopped) return null;
    await this.verifyChrome();
    return this.ensureChromePort();
  }

  protected browserSocketLost(): void {
    void this.verifyChrome();
  }

  /** Only report a port when our private Chrome is already up — never launch it. */
  protected async reachableChromePort(): Promise<number | null> {
    return this.chrome ? this.chrome.port : null;
  }
}

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
