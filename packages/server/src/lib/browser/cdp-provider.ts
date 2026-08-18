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
 * to the user's already-running one.
 */

import { BrowserSession, type BrowserSessionOptions } from './session.js';
import type {
  BrowserProvider,
  BrowserProviderStats,
  AdoptedTab,
  BrowserSessionInfo,
  BrowserTabEvent,
} from './types.js';
import { CDPClient } from './cdp.js';
import { BrowserSessionStore } from './session-store.js';
import { getBrowserIdleMinutes } from '../../config.js';

export const MAX_SESSIONS = 5;
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

/**
 * What a caller-chosen `browserId` may look like.
 *
 * Named sessions are the P1 handle on a tab — `createSession('inbox')` and the
 * window that reopens tomorrow still finds it — so the id stops being an internal
 * counter and starts being something a human types and a URL carries
 * (`?browserId=…`), a filename holds, and a `yaar://system/browsers/{id}` address
 * resolves. Restricting it here is what keeps all three from needing to think
 * about escaping.
 */
const BROWSER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How many times a crashed session is revived before it is left dead. */
const MAX_CRASH_RESTARTS = 3;

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
  /**
   * Which browserId is behind each CDP target. The reverse of what the session map
   * holds, and the only honest way to answer "who opened this popup?" — CDP names
   * the *opener target*, not a browserId.
   */
  protected targetOwners = new Map<string, string>();
  /**
   * Sessions that exist only because a target does: adopted popups and the user's
   * own tabs. Nothing on disk remembers them, so when their target dies there is
   * nothing to revive and the entry is dropped rather than left as a stale id.
   */
  protected ephemeralSessions = new Set<string>();
  private tabListeners = new Set<(event: BrowserTabEvent) => void>();
  private discoveryPromise: Promise<void> | null = null;
  /** The named sessions this provider has, as they survive a restart. */
  protected readonly store = new BrowserSessionStore();
  private restartCounts = new Map<string, number>();
  private reviving = new Map<string, Promise<BrowserSession | null>>();

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
    const idleMs = getBrowserIdleMinutes() * 60 * 1000;
    if (idleMs <= 0) return;

    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, session] of this.sessions) {
      // Someone is looking at this tab. Reading a long page is not idleness, and
      // the pre-P1 sweep would take the canvas out from under them mid-article.
      if (session.screencasting) continue;
      if (now - session.lastActivity > idleMs) {
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

  /**
   * Put a session in the map and give it the lifecycle a process has: its state is
   * written down as it changes, and its death is something the provider reacts to
   * rather than something a viewer discovers by looking at a frozen canvas.
   *
   * `persist` is false for a tab we merely adopted — the user's own window, or a
   * popup a page opened. Those are not ours to recreate, and writing them down
   * would have YAAR reopening someone else's tabs after a restart.
   */
  protected track(
    browserId: string,
    session: BrowserSession,
    { persist }: { persist: boolean },
  ): void {
    this.sessions.set(browserId, session);
    if (!persist || !this.ownsChrome) return;

    void this.store.load().then(() => {
      this.store.remember(browserId, {
        url: session.currentUrl,
        title: session.currentTitle,
        mobile: session.mobile,
        windowId: session.windowId,
      });
    });

    session.on('updated', () => {
      this.store.remember(browserId, {
        url: session.currentUrl,
        title: session.currentTitle,
        mobile: session.mobile,
        windowId: session.windowId,
      });
    });

    session.on('crashed', () => {
      void this.restartCrashed(browserId, session);
    });
  }

  /**
   * Bring a crashed tab back where it left off — work item 4's "crash-restart with
   * URL replay".
   *
   * Bounded, because a page that crashes Chrome on load would otherwise be revived
   * into crashing forever. After {@link MAX_CRASH_RESTARTS} the session is dropped
   * and the window is left showing the failure, which is the honest outcome.
   */
  private async restartCrashed(browserId: string, session: BrowserSession): Promise<void> {
    if (this.sessions.get(browserId) !== session) return;

    const attempts = (this.restartCounts.get(browserId) ?? 0) + 1;
    if (attempts > MAX_CRASH_RESTARTS) {
      console.error(`[browser] Session ${browserId} crashed ${attempts - 1}x — giving up`);
      this.restartCounts.delete(browserId);
      await this.closeSession(browserId).catch(() => {});
      return;
    }
    this.restartCounts.set(browserId, attempts);

    try {
      const port = await this.reachableChromePort();
      if (port == null) return; // Chrome itself is gone; a revive would relaunch it.
      const target = await this.openTarget(port);
      await session.reattach(target.webSocketDebuggerUrl, session.currentUrl);
      this.knownTargetIds.add(target.id);
      this.targetOwners.set(target.id, browserId);
      console.log(`[browser] Session ${browserId} revived → ${session.currentUrl}`);
      this.restartCounts.delete(browserId);
    } catch (err) {
      console.error(`[browser] Failed to revive session ${browserId}:`, err);
    }
  }

  /**
   * Get a live session back for a `browserId` that has a record but no socket —
   * the desktop reloaded, the idle sweep collected it, or the server restarted.
   *
   * This is what turns "No browser session 0" from a dead canvas into a page. A
   * caller that just wants the session if it happens to exist uses
   * {@link getSession}; this one is for the paths where the id is a *promise* the
   * window is holding us to.
   */
  async reviveSession(browserId: string): Promise<BrowserSession | null> {
    const live = this.sessions.get(browserId);
    if (live && !live.isClosed) return live;

    const inFlight = this.reviving.get(browserId);
    if (inFlight) return inFlight;

    const attempt = (async () => {
      await this.store.load();
      const record = this.store.get(browserId);
      if (!record) return null;
      if (this.sessions.size + this.pendingSessions >= MAX_SESSIONS) return null;

      const { session } = await this.createSession(browserId, { mobile: record.mobile });
      session.windowId = record.windowId;
      if (/^https?:/i.test(record.url)) {
        const state = await session.navigate(record.url, 'domcontentloaded').catch(() => null);
        if (state) {
          session.currentUrl = state.url;
          session.currentTitle = state.title;
        }
      }
      console.log(`[browser] Revived session ${browserId} → ${session.currentUrl}`);
      return session;
    })().finally(() => this.reviving.delete(browserId));

    this.reviving.set(browserId, attempt);
    return attempt.catch((err) => {
      console.error(`[browser] Revive failed for ${browserId}:`, err);
      return null;
    });
  }

  /** Open one fresh tab and return its target record. */
  private async openTarget(port: number): Promise<{ id: string; webSocketDebuggerUrl: string }> {
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
    return (await resp.json()) as { id: string; webSocketDebuggerUrl: string };
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

      this.browserCdp.on('Target.targetDestroyed', (params: unknown) => {
        const { targetId } = params as { targetId?: string };
        if (typeof targetId === 'string') this.handleTargetGone(targetId);
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

    // Chrome names the opener target outright. The old reading of this — "whichever
    // session was active most recently" — was only ever right when an agent's click
    // was the last thing that happened, which is exactly not the case while a human
    // is driving the page live.
    const openerBrowserId = targetInfo.openerId
      ? this.targetOwners.get(targetInfo.openerId)
      : undefined;

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
        // Adopted passively, and never re-navigated. A popup is a page that already
        // exists: sending it to its own URL again replays a one-time OAuth callback,
        // wipes an `about:blank` popup the opener is writing into, and the emulation
        // overrides would stretch a 500×600 window to desktop metrics.
        const session = await BrowserSession.create(browserId, target.webSocketDebuggerUrl, {
          adopt: true,
        });
        session.openerBrowserId = openerBrowserId;
        session.currentUrl = target.url || session.currentUrl;
        this.knownTargetIds.add(target.id);
        this.targetOwners.set(target.id, browserId);
        this.ephemeralSessions.add(browserId);
        this.track(browserId, session, { persist: false });
        // A popup is usually still navigating when it is announced, so its address
        // is read once it has settled rather than from the announcement.
        await new Promise((r) => setTimeout(r, 500));
        await session.refreshLocation();
        this.pendingAdoptions.set(browserId, { browserId, openerBrowserId });
        this.emitTabEvent({
          type: 'opened',
          browserId,
          url: session.currentUrl,
          title: session.currentTitle,
          openerBrowserId,
        });
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
   * A target went away — the page closed its popup, the user closed the tab.
   *
   * Announced so a viewer watching that tab can step back to whatever opened it,
   * instead of holding a canvas that will never paint again. An ephemeral session
   * goes with its target: there is no record to revive it from, and leaving the
   * entry behind would offer an id that resolves to a dead socket.
   */
  private handleTargetGone(targetId: string): void {
    const browserId = this.targetOwners.get(targetId);
    this.targetOwners.delete(targetId);
    this.adoptedTargets.delete(targetId);
    this.knownTargetIds.delete(targetId);
    if (!browserId) return;

    const session = this.sessions.get(browserId);
    this.emitTabEvent({
      type: 'closed',
      browserId,
      openerBrowserId: session?.openerBrowserId,
    });

    if (!this.ephemeralSessions.delete(browserId) || !session) return;
    this.sessions.delete(browserId);
    this.pendingAdoptions.delete(browserId);
    void session.close().catch(() => {});
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
        this.targetOwners.set(t.id, browserId);
        this.ephemeralSessions.add(browserId);
        const session = await BrowserSession.create(browserId, t.webSocketDebuggerUrl, {
          adopt: true,
        });
        session.currentUrl = url || 'about:blank';
        session.currentTitle = t.title || '';
        this.track(browserId, session, { persist: false });
        console.log(
          `[browser] Adopted existing tab [browser:${browserId}] → ${session.currentUrl}`,
        );
      } catch (err) {
        this.adoptedTargets.delete(t.id);
        this.knownTargetIds.delete(t.id);
        this.targetOwners.delete(t.id);
        this.ephemeralSessions.delete(browserId);
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

  onTabEvent(listener: (event: BrowserTabEvent) => void): () => void {
    this.tabListeners.add(listener);
    return () => {
      this.tabListeners.delete(listener);
    };
  }

  /** Fan out to viewers. A listener that throws is its own problem, not Chrome's. */
  protected emitTabEvent(event: BrowserTabEvent): void {
    for (const listener of this.tabListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[browser] Tab event listener failed:', err);
      }
    }
  }

  /** Disconnect shared CDP/discovery state, then release the process (if ours). */
  protected async closeEndpoint() {
    if (this.browserCdp) {
      this.browserCdp.close();
      this.browserCdp = null;
    }
    this.adoptedTargets.clear();
    this.knownTargetIds.clear();
    this.targetOwners.clear();
    this.ephemeralSessions.clear();
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
    } else {
      if (!BROWSER_ID_PATTERN.test(browserId)) {
        throw new Error(
          `Invalid browserId "${browserId}". Use letters, digits, "-" or "_" (max 64 chars).`,
        );
      }
      // A caller naming "7" must not hand the counter a collision to mint later.
      const asNumber = Number(browserId);
      if (Number.isInteger(asNumber) && asNumber >= this.nextId) this.nextId = asNumber + 1;
    }

    this.pendingSessions++;
    try {
      const port = await this.ensureChromePort();
      await this.ensureDiscovery(port);
      if (this.ownsChrome) this.startCleanup();

      const target = await this.openTarget(port);
      const session = await BrowserSession.create(browserId, target.webSocketDebuggerUrl, options);
      this.knownTargetIds.add(target.id);
      this.targetOwners.set(target.id, browserId);
      this.track(browserId, session, { persist: options?.adopt !== true });
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
    // A close is a decision — the user shut the window, the agent closed the tab —
    // so the record goes with it. The idle sweep deliberately does *not* come
    // through here (see `cleanupIdle`): a collected session keeps its record and
    // comes back the next time someone asks for that id.
    this.restartCounts.delete(browserId);
    this.ephemeralSessions.delete(browserId);
    for (const [targetId, owner] of this.targetOwners) {
      if (owner === browserId) this.targetOwners.delete(targetId);
    }
    this.store.forget(browserId);

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

  /**
   * Shut down everything — called on server exit.
   *
   * Sessions are closed directly rather than through {@link closeSession}: exiting
   * is not the user deciding to be rid of these tabs, so their records stay on disk
   * and the next launch can revive them into the profile that still holds their
   * cookies.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();
    await this.store.flush().catch(() => {});
    await this.closeEndpoint();
  }

  getStats(): BrowserProviderStats {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
      chromeRunning: this.chromeRunning,
    };
  }

  /**
   * Every session this provider knows about — live ones first, then records with
   * no socket behind them right now. The second group is the point: a reloaded
   * desktop or a swept-away tab should show up as *revivable*, not as absent.
   */
  async listSessionInfo(): Promise<BrowserSessionInfo[]> {
    const now = Date.now();
    const out: BrowserSessionInfo[] = [];

    for (const [id, session] of this.sessions) {
      out.push({
        id,
        url: session.currentUrl,
        title: session.currentTitle || '(no title)',
        mobile: session.mobile,
        windowId: session.windowId,
        state: session.isCrashed ? 'crashed' : 'live',
        driving: session.driving,
        viewers: session.screencasting ? 1 : 0,
        createdAt: session.createdAt,
        idleMs: now - session.lastActivity,
        jsHeapBytes: await session.jsHeapBytes().catch(() => null),
      });
    }

    if (this.ownsChrome) {
      await this.store.load();
      for (const record of this.store.list()) {
        if (this.sessions.has(record.id)) continue;
        out.push({
          id: record.id,
          url: record.url,
          title: record.title || '(no title)',
          mobile: record.mobile,
          windowId: record.windowId,
          state: 'suspended',
          driving: false,
          viewers: 0,
          createdAt: record.createdAt,
          idleMs: now - record.updatedAt,
          jsHeapBytes: null,
        });
      }
    }

    return out;
  }
}
