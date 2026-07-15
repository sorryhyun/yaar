/**
 * LocalUserBrowser — a BrowserProvider that drives the user's OWN Chrome.
 *
 * Instead of launching a private headless Chrome (`HeadlessServerBrowser`), this
 * attaches over CDP to a Chrome the user already started with
 * `--remote-debugging-port=<CHROME_DEBUG_PORT>`. Tabs YAAR opens are real
 * top-level tabs in that browser, with the user's real cookies, logins, and
 * sessions — no re-auth, no second Chrome process.
 *
 * Phase 2 (dev / power-user): opt in with `YAAR_BROWSER_PROVIDER=local`. The
 * companion-extension productization and full auto-selection come later.
 *
 * It reuses every bit of CDP/session plumbing from `CdpBrowserProvider`; the
 * only differences are:
 *  - the endpoint is *discovered*, never launched (`ensureChromePort`),
 *  - YAAR never owns or kills the process (`ownsChrome = false`), so idle tabs
 *    are left alone and the user's browser is never shut down by YAAR.
 */

import { CdpBrowserProvider } from './cdp-provider.js';
import { CHROME_DEBUG_PORT } from '../../config.js';

export class LocalUserBrowser extends CdpBrowserProvider {
  private readonly debugPort: number;
  private connected = false;

  constructor(debugPort: number = CHROME_DEBUG_PORT) {
    super();
    this.debugPort = debugPort;
  }

  readonly controlsUserBrowser = true;

  protected get ownsChrome(): boolean {
    return false;
  }

  protected get chromeRunning(): boolean {
    return this.connected;
  }

  /** Reachable iff the user's Chrome is exposing a DevTools endpoint. */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  protected async ensureChromePort(): Promise<number> {
    if (this.connected) return this.debugPort;
    // Verify the endpoint is reachable before handing out the port.
    let ok = false;
    try {
      const resp = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      ok = resp.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `Could not reach the user's Chrome on 127.0.0.1:${this.debugPort}. ` +
          `Launch Chrome with --remote-debugging-port=${this.debugPort} ` +
          `(or set CHROME_DEBUG_PORT), or unset YAAR_BROWSER_PROVIDER to use the headless browser.`,
      );
    }
    this.connected = true;
    return this.debugPort;
  }

  /**
   * The user's Chrome is never ours to kill — releasing only drops our
   * browser-level CDP connection (handled by the base `closeEndpoint`).
   */
  protected async releaseProcess(): Promise<void> {
    this.connected = false;
  }

  /** The user's debug port, but only when their Chrome is actually reachable. */
  protected async reachableChromePort(): Promise<number | null> {
    return (await this.isAvailable()) ? this.debugPort : null;
  }
}
