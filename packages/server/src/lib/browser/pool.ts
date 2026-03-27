/**
 * BrowserPool — singleton managing Chrome process and tab sessions.
 *
 * Lazy-launches one headless Chrome process and creates isolated tabs
 * keyed by browserId (auto-incrementing integer). Enforces a max concurrent
 * limit and auto-closes sessions idle for too long.
 *
 * Uses the system Chrome/Edge — no bundled browser binary needed.
 */

import { BrowserSession, type BrowserSessionOptions } from './session.js';
import { CDPClient } from './cdp.js';
import {
  findChrome,
  launchChrome,
  cleanupChrome,
  cleanupStaleChrome,
  writePidFile,
  type ChromeInstance,
} from './chrome.js';

const MAX_SESSIONS = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

export class BrowserPool {
  private chrome: ChromeInstance | null = null;
  private sessions = new Map<string, BrowserSession>();
  private nextId = 0;
  private pendingSessions = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initPromise: Promise<ChromeInstance> | null = null;
  private chromePath: string | null | undefined; // undefined = not checked yet
  private browserCdp: CDPClient | null = null;
  private adoptedTargets = new Set<string>();
  private knownTargetIds = new Set<string>();
  private pendingAdoptions = new Map<string, { browserId: string; openerBrowserId?: string }>();

  /**
   * Check if a Chrome/Edge binary is available on this system.
   */
  async isAvailable(): Promise<boolean> {
    if (this.chromePath === undefined) {
      this.chromePath = await findChrome();
    }
    return this.chromePath !== null;
  }

  /**
   * Lazy-launch the Chrome process.
   */
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
      await this.setupTargetDiscovery(instance);
      this.startCleanup();
      console.log(`[browser] Chrome launched on port ${instance.port}`);
      return instance;
    })();

    return this.initPromise;
  }

  private startCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), CLEANUP_INTERVAL_MS);
  }

  private async cleanupIdle() {
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

    // If no sessions left, kill Chrome to free memory
    if (this.sessions.size === 0 && this.chrome) {
      await this.closeChrome();
    }
  }

  /** Connect to browser-level CDP for target discovery (auto-adopt new tabs). */
  private async setupTargetDiscovery(chrome: ChromeInstance): Promise<void> {
    try {
      const resp = await fetch(`http://127.0.0.1:${chrome.port}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
      if (!info.webSocketDebuggerUrl) return;

      this.browserCdp = await CDPClient.connect(info.webSocketDebuggerUrl);
      await this.browserCdp.send('Target.setDiscoverTargets', { discover: true });

      this.browserCdp.on('Target.targetCreated', (params: unknown) => {
        const p = params as {
          targetInfo: { targetId: string; type: string; url: string; openerId?: string };
        };
        if (p.targetInfo.type !== 'page') return;
        if (this.knownTargetIds.has(p.targetInfo.targetId)) return;
        if (this.adoptedTargets.has(p.targetInfo.targetId)) return;
        if (p.targetInfo.url === 'about:blank' && !p.targetInfo.openerId) return;

        this.handleNewTarget(p.targetInfo, chrome.port).catch((err) => {
          console.error('[browser] Failed to adopt new tab:', err);
        });
      });
    } catch (err) {
      console.error('[browser] Target discovery setup failed:', err);
    }
  }

  private async handleNewTarget(
    targetInfo: { targetId: string; url: string; openerId?: string },
    chromePort: number,
  ): Promise<void> {
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

  /** Check and consume any pending auto-adopted tabs. */
  consumeAdoptedTabs(): Array<{ browserId: string; url: string; openerBrowserId?: string }> {
    const result: Array<{ browserId: string; url: string; openerBrowserId?: string }> = [];
    for (const [browserId, info] of this.pendingAdoptions) {
      const session = this.sessions.get(browserId);
      if (session) {
        result.push({ browserId, url: session.currentUrl, openerBrowserId: info.openerBrowserId });
      }
    }
    this.pendingAdoptions.clear();
    return result;
  }

  private async closeChrome() {
    if (this.browserCdp) {
      this.browserCdp.close();
      this.browserCdp = null;
    }
    this.adoptedTargets.clear();
    this.knownTargetIds.clear();
    this.pendingAdoptions.clear();
    if (this.chrome) {
      await cleanupChrome(this.chrome);
      this.chrome = null;
      this.initPromise = null;
      console.log('[browser] Chrome process closed');
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Create a new browser tab. Auto-assigns the next browserId if omitted.
   */
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
      const chrome = await this.getChrome();

      // Create a new tab via Chrome's HTTP debugging API
      // Newer Chrome versions require PUT for /json/new; fall back to GET for older ones.
      let resp = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        resp = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, {
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

  /**
   * Get a browser session by ID.
   */
  getSession(browserId: string): BrowserSession | undefined {
    return this.sessions.get(browserId);
  }

  /**
   * Get all open browser sessions (browserId → session).
   */
  getAllSessions(): Map<string, BrowserSession> {
    return new Map(this.sessions);
  }

  /**
   * Close and remove a browser by ID.
   */
  async closeSession(browserId: string): Promise<void> {
    const session = this.sessions.get(browserId);
    if (session) {
      this.sessions.delete(browserId);
      await session.close();
    }

    // Kill Chrome if no sessions left
    if (this.sessions.size === 0) {
      await this.closeChrome();
    }
  }

  /**
   * Close all browser sessions (but keep Chrome alive for reuse).
   */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
  }

  /**
   * Find session bound to a specific YAAR window.
   */
  findByWindowId(windowId: string): BrowserSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.windowId === windowId) return session;
    }
    return undefined;
  }

  /**
   * Shut down everything — called on server exit.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();
    await this.closeChrome();
  }

  getStats() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
      chromeRunning: this.chrome !== null,
    };
  }
}

/** Singleton instance. */
let pool: BrowserPool | undefined;

export function getBrowserPool(): BrowserPool {
  if (!pool) pool = new BrowserPool();
  return pool;
}
