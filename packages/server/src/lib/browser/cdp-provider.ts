/**
 * CdpBrowserProvider — shared CDP plumbing for browser providers.
 *
 * Holds everything that is identical between the two `BrowserProvider`
 * implementations: the session map, browserId assignment, tab creation via
 * Chrome's HTTP debugging API, target discovery / auto-adoption of popups, the
 * idle-cleanup loop, and stats.
 *
 * Subclasses supply only what genuinely differs:
 *  - where the CDP endpoint comes from (`ensureChromePort`),
 *  - whether YAAR owns the Chrome process and may kill it (`ownsChrome`),
 *  - how to tear that process down (`releaseProcess`),
 *  - liveness for stats (`chromeRunning`),
 *  - availability (`isAvailable`).
 *
 * `HeadlessServerBrowser` launches a private Chrome; `LocalUserBrowser` attaches
 * to the user's already-running one. See docs/browser_substrate_proposal.md.
 */

import { BrowserSession, type BrowserSessionOptions } from './session.js';
import type { BrowserProvider, BrowserProviderStats, AdoptedTab } from './types.js';
import { CDPClient } from './cdp.js';

export const MAX_SESSIONS = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

interface NewTargetInfo {
  targetId: string;
  type?: string;
  url: string;
  openerId?: string;
}

export abstract class CdpBrowserProvider implements BrowserProvider {
  protected sessions = new Map<string, BrowserSession>();
  protected nextId = 0;
  protected pendingSessions = 0;
  protected cleanupTimer: ReturnType<typeof setInterval> | null = null;
  protected browserCdp: CDPClient | null = null;
  protected adoptedTargets = new Set<string>();
  protected knownTargetIds = new Set<string>();
  protected pendingAdoptions = new Map<string, { browserId: string; openerBrowserId?: string }>();
  private discoveryPromise: Promise<void> | null = null;

  // ── Subclass contract ──────────────────────────────────────────────────────

  /** Whether this provider drives the user's own browser (see interface docs). */
  abstract readonly controlsUserBrowser: boolean;

  /** Whether this provider can serve sessions in the current environment. */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Bring up (or reuse) the CDP endpoint and return its debug port.
   * Must be idempotent — called on every `createSession`.
   */
  protected abstract ensureChromePort(): Promise<number>;

  /** Whether YAAR owns the Chrome process (and may kill it when idle/empty). */
  protected abstract get ownsChrome(): boolean;

  /** True while the underlying endpoint is live (reported via `getStats`). */
  protected abstract get chromeRunning(): boolean;

  /** Tear down the Chrome process. No-op when the process isn't ours. */
  protected abstract releaseProcess(): Promise<void>;

  /**
   * The debug port of an *already-reachable* endpoint, or `null` if none is up.
   * Must NOT launch Chrome — this gates passive operations (`syncExistingTabs`)
   * that should never boot a browser just to read it.
   */
  protected abstract reachableChromePort(): Promise<number | null>;

  // ── Shared lifecycle ─────────────────────────────────────────────────────────

  protected startCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), CLEANUP_INTERVAL_MS);
  }

  protected async cleanupIdle() {
    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        toClose.push(id);
      }
    }

    for (const id of toClose) {
      const session = this.sessions.get(id);
      if (session) {
        console.log(`[browser] Closing idle browser ${id} (window: ${session.windowId})`);
        this.sessions.delete(id);
        await session.close().catch(() => {});
      }
    }

    // If no sessions left, release the Chrome process (only when we own it).
    if (this.sessions.size === 0 && this.ownsChrome) {
      await this.closeEndpoint();
    }
  }

  /** Set up browser-level CDP target discovery once. Idempotent. */
  protected ensureDiscovery(port: number): Promise<void> {
    if (this.browserCdp) return Promise.resolve();
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.setupTargetDiscovery(port).finally(() => {
      if (!this.browserCdp) this.discoveryPromise = null;
    });
    return this.discoveryPromise;
  }

  /** Connect to browser-level CDP for target discovery (auto-adopt new tabs). */
  private async setupTargetDiscovery(port: number): Promise<void> {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
      if (!info.webSocketDebuggerUrl) return;

      this.browserCdp = await CDPClient.connect(info.webSocketDebuggerUrl);
      await this.browserCdp.send('Target.setDiscoverTargets', { discover: true });

      this.browserCdp.on('Target.targetCreated', (params: unknown) => {
        const p = params as { targetInfo: NewTargetInfo };
        if (p.targetInfo.type !== 'page') return;
        if (this.knownTargetIds.has(p.targetInfo.targetId)) return;
        if (this.adoptedTargets.has(p.targetInfo.targetId)) return;
        if (p.targetInfo.url === 'about:blank' && !p.targetInfo.openerId) return;

        this.handleNewTarget(p.targetInfo, port).catch((err) => {
          console.error('[browser] Failed to adopt new tab:', err);
        });
      });
    } catch (err) {
      console.error('[browser] Target discovery setup failed:', err);
    }
  }

  private async handleNewTarget(targetInfo: NewTargetInfo, chromePort: number): Promise<void> {
    if (this.sessions.size + this.pendingSessions >= MAX_SESSIONS) {
      console.log('[browser] Cannot adopt new tab — limit reached');
      return;
    }

    this.adoptedTargets.add(targetInfo.targetId);

    // Find opener browser ID by most recently active session
    let openerBrowserId: string | undefined;
    if (targetInfo.openerId) {
      let latestActivity = 0;
      for (const [bid, session] of this.sessions) {
        if (session.lastActivity > latestActivity) {
          latestActivity = session.lastActivity;
          openerBrowserId = bid;
        }
      }
    }

    const browserId = String(this.nextId++);

    try {
      const resp = await fetch(`http://127.0.0.1:${chromePort}/json`, {
        signal: AbortSignal.timeout(5000),
      });
      const targets = (await resp.json()) as Array<{
        id: string;
        webSocketDebuggerUrl: string;
        url: string;
      }>;
      const target = targets.find((t) => t.id === targetInfo.targetId);
      if (!target) return;

      this.pendingSessions++;
      try {
        const session = await BrowserSession.create(browserId, target.webSocketDebuggerUrl);
        session.openerBrowserId = openerBrowserId;
        // Wait a moment for the page to load
        await new Promise((r) => setTimeout(r, 500));
        // Get current URL
        const urlTitle = await session
          .navigate(target.url || session.currentUrl, 'domcontentloaded')
          .catch(() => null);
        if (urlTitle) {
          session.currentUrl = urlTitle.url;
          session.currentTitle = urlTitle.title;
        }
        this.sessions.set(browserId, session);
        this.pendingAdoptions.set(browserId, { browserId, openerBrowserId });
        console.log(
          `[browser] Auto-adopted new tab [browser:${browserId}] → ${session.currentUrl} (opened by browser:${openerBrowserId})`,
        );
      } finally {
        this.pendingSessions--;
      }
    } catch (err) {
      console.error('[browser] Failed to adopt target:', err);
    }
  }

  /**
   * Adopt every already-open page target we haven't seen yet.
   *
   * The `Target.targetCreated` discovery handler only fires for tabs created
   * *after* discovery is enabled, so tabs the user already had open (notably
   * YAAR's own tab) never enter the session map and a passive `list_tabs`
   * misses them. This enumerates Chrome's current `/json` target list and
   * attaches to anything new — passively (`adopt: true`): no navigation, no
   * viewport resize, URL/title taken straight from the `/json` entry. Never
   * launches Chrome (bails when no endpoint is reachable).
   */
  async syncExistingTabs(): Promise<void> {
    const port = await this.reachableChromePort();
    if (port == null) return;

    // Wire up discovery too, so tabs opened *after* this point still auto-adopt.
    await this.ensureDiscovery(port);

    let targets: Array<{
      id: string;
      type?: string;
      url?: string;
      title?: string;
      webSocketDebuggerUrl?: string;
    }>;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(5000),
      });
      targets = (await resp.json()) as typeof targets;
    } catch (err) {
      console.error('[browser] Failed to enumerate existing targets:', err);
      return;
    }
    if (!Array.isArray(targets)) return;

    for (const t of targets) {
      if (t.type !== 'page') continue;
      if (!t.webSocketDebuggerUrl) continue; // not attachable (e.g. DevTools already open)
      if (this.knownTargetIds.has(t.id) || this.adoptedTargets.has(t.id)) continue;
      const url = t.url || '';
      // Skip internal / scratch pages — nothing useful to address there.
      if (/^(chrome|chrome-extension|devtools|about|edge):/.test(url)) continue;
      if (this.sessions.size + this.pendingSessions >= MAX_SESSIONS) break;

      this.adoptedTargets.add(t.id);
      this.knownTargetIds.add(t.id);
      const browserId = String(this.nextId++);
      this.pendingSessions++;
      try {
        const session = await BrowserSession.create(browserId, t.webSocketDebuggerUrl, {
          adopt: true,
        });
        session.currentUrl = url || 'about:blank';
        session.currentTitle = t.title || '';
        this.sessions.set(browserId, session);
        console.log(
          `[browser] Adopted existing tab [browser:${browserId}] → ${session.currentUrl}`,
        );
      } catch (err) {
        this.adoptedTargets.delete(t.id);
        this.knownTargetIds.delete(t.id);
        console.error('[browser] Failed to adopt existing tab:', err);
      } finally {
        this.pendingSessions--;
      }
    }
  }

  /** Check and consume any pending auto-adopted tabs. */
  consumeAdoptedTabs(): AdoptedTab[] {
    const result: AdoptedTab[] = [];
    for (const [browserId, info] of this.pendingAdoptions) {
      const session = this.sessions.get(browserId);
      if (session) {
        result.push({ browserId, url: session.currentUrl, openerBrowserId: info.openerBrowserId });
      }
    }
    this.pendingAdoptions.clear();
    return result;
  }

  /** Disconnect shared CDP/discovery state, then release the process (if ours). */
  protected async closeEndpoint() {
    if (this.browserCdp) {
      this.browserCdp.close();
      this.browserCdp = null;
    }
    this.adoptedTargets.clear();
    this.knownTargetIds.clear();
    this.pendingAdoptions.clear();
    this.discoveryPromise = null;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.releaseProcess();
  }

  /** Create a new browser tab. Auto-assigns the next browserId if omitted. */
  async createSession(
    browserId?: string,
    options?: BrowserSessionOptions,
  ): Promise<{ session: BrowserSession; browserId: string }> {
    if (this.sessions.size + this.pendingSessions >= MAX_SESSIONS) {
      throw new Error(
        `Browser limit reached (max ${MAX_SESSIONS}). Close an existing browser first.`,
      );
    }

    if (browserId === undefined) {
      browserId = String(this.nextId++);
    }

    this.pendingSessions++;
    try {
      const port = await this.ensureChromePort();
      await this.ensureDiscovery(port);
      if (this.ownsChrome) this.startCleanup();

      // Create a new tab via Chrome's HTTP debugging API.
      // Newer Chrome versions require PUT for /json/new; fall back to GET for older ones.
      let resp = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        resp = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
          signal: AbortSignal.timeout(10_000),
        });
      }
      const target = (await resp.json()) as { id: string; webSocketDebuggerUrl: string };

      const session = await BrowserSession.create(browserId, target.webSocketDebuggerUrl, options);
      this.knownTargetIds.add(target.id);
      this.sessions.set(browserId, session);
      return { session, browserId };
    } finally {
      this.pendingSessions--;
    }
  }

  getSession(browserId: string): BrowserSession | undefined {
    return this.sessions.get(browserId);
  }

  getAllSessions(): Map<string, BrowserSession> {
    return new Map(this.sessions);
  }

  async closeSession(browserId: string): Promise<void> {
    const session = this.sessions.get(browserId);
    if (session) {
      this.sessions.delete(browserId);
      await session.close();
    }

    // Release the Chrome process if no sessions remain — only when we own it.
    if (this.sessions.size === 0 && this.ownsChrome) {
      await this.closeEndpoint();
    }
  }

  /** Close all sessions (keeps the endpoint alive for reuse). */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
  }

  /** Find the session bound to a specific YAAR window. */
  findByWindowId(windowId: string): BrowserSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.windowId === windowId) return session;
    }
    return undefined;
  }

  /** Shut down everything — called on server exit. */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();
    await this.closeEndpoint();
  }

  getStats(): BrowserProviderStats {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
      chromeRunning: this.chromeRunning,
    };
  }
}
