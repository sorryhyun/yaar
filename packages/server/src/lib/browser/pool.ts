/**
 * BrowserPool — singleton managing Chrome process and tab sessions.
 *
 * Lazy-launches one headless Chrome process and creates isolated tabs
 * per session via CDP. Tracks sessions by ID, enforces a max concurrent limit,
 * and auto-closes sessions idle for too long.
 *
 * Uses the system Chrome/Edge — no bundled browser binary needed.
 */

import { BrowserSession } from './session.js';
import { findChrome, launchChrome, cleanupChrome, type ChromeInstance } from './chrome.js';

const MAX_SESSIONS = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

export class BrowserPool {
  private chrome: ChromeInstance | null = null;
  private sessions = new Map<string, BrowserSession>();
  private pendingSessions = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initPromise: Promise<ChromeInstance> | null = null;
  private chromePath: string | null | undefined; // undefined = not checked yet

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
      const instance = await launchChrome(this.chromePath!);
      this.chrome = instance;
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
        console.log(`[browser] Closing idle session ${id} (window: ${session.windowId})`);
        this.sessions.delete(id);
        await session.close().catch(() => {});
      }
    }

    // If no sessions left, kill Chrome to free memory
    if (this.sessions.size === 0 && this.chrome) {
      await this.closeChrome();
    }
  }

  private async closeChrome() {
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
   * Create a new browser session (opens a Chrome tab).
   */
  async createSession(id: string): Promise<BrowserSession> {
    if (this.sessions.size + this.pendingSessions >= MAX_SESSIONS) {
      throw new Error(
        `Browser session limit reached (max ${MAX_SESSIONS}). Close an existing session first.`,
      );
    }

    this.pendingSessions++;
    try {
      const chrome = await this.getChrome();

      // Create a new tab via Chrome's HTTP debugging API
      // Newer Chrome versions require PUT for /json/new; fall back to GET for older ones.
      let resp = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, {
        method: 'PUT',
      });
      if (!resp.ok) {
        resp = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`);
      }
      const target = (await resp.json()) as { id: string; webSocketDebuggerUrl: string };

      const session = await BrowserSession.create(id, target.webSocketDebuggerUrl);
      this.sessions.set(id, session);
      return session;
    } finally {
      this.pendingSessions--;
    }
  }

  /**
   * Get an existing session by ID.
   */
  getSession(id: string): BrowserSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Close and remove a session by ID.
   */
  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      await session.close();
    }

    // Kill Chrome if no sessions left
    if (this.sessions.size === 0) {
      await this.closeChrome();
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
