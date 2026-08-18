/**
 * Browser automation types.
 */

import type { BrowserSession, BrowserSessionOptions } from './session.js';

/**
 * Stats reported by a browser provider for `yaar://` system introspection.
 */
export interface BrowserProviderStats {
  activeSessions: number;
  maxSessions: number;
  chromeRunning: boolean;
}

/**
 * One browser session as an inspectable *process* — what Process Explorer lists
 * and `read('yaar://system/browsers')` answers with.
 *
 * `state` is the P1 distinction that matters: a session is not simply present or
 * absent. `suspended` means the id still names something (its page, its window,
 * its cookies in the persisted profile) with no CDP socket behind it right now —
 * the state a desktop reload or the idle sweep leaves behind, and the one a
 * revive turns back into `live`.
 */
export interface BrowserSessionInfo {
  id: string;
  url: string;
  title: string;
  mobile: boolean;
  windowId?: string;
  state: 'live' | 'suspended' | 'crashed';
  /** Whether an agent is mid-action on this tab right now. */
  driving: boolean;
  /** Live screencast viewers attached — 0 means nobody is looking. */
  viewers: number;
  createdAt: number;
  /** Milliseconds since anything touched this session. */
  idleMs: number;
  /** Page JS heap, where Chrome will say. A weight proxy, not an accounting. */
  jsHeapBytes: number | null;
}

/**
 * Info about a tab that was auto-adopted (e.g. opened via `window.open`),
 * waiting to be surfaced to the agent on its next turn.
 */
export interface AdoptedTab {
  browserId: string;
  url: string;
  openerBrowserId?: string;
}

/**
 * A tab appearing or disappearing, pushed the moment it happens.
 *
 * {@link AdoptedTab} is the *pull* half of the same fact, drained by the agent on
 * its next click. That half is useless to a human driving the tab live: nothing
 * in the screencast path calls a verb, so nobody would ever drain it and the
 * canvas would sit on the opener while the popup it just opened lived on
 * unwatched. Viewers subscribe to this instead, and follow the target.
 */
export type BrowserTabEvent =
  | {
      type: 'opened';
      browserId: string;
      url: string;
      title: string;
      /** The tab whose page called `window.open`, when CDP named one. */
      openerBrowserId?: string;
    }
  | { type: 'closed'; browserId: string; openerBrowserId?: string };

/**
 * BrowserProvider — the backend behind `POST /api/browser`.
 *
 * Abstracts *where browser tabs come from*. Two implementations:
 *  - `HeadlessServerBrowser` — launches a private server-side Chrome (the default;
 *    correct for headless / cloud / no-display / Claude-in-Claude / eval runs).
 *  - `LocalUserBrowser` — attaches to the user's own running Chrome (real cookies,
 *    real logins, real tabs). [planned]
 *
 * Both produce `BrowserSession` instances, which already abstract a single CDP
 * target — so the session layer is shared verbatim across providers.
 */
export interface BrowserProvider {
  /**
   * True when this provider drives the *user's own* browser (real cookies,
   * logins, sessions) rather than a private sandboxed Chrome. Gates the Phase 3
   * tab-control consent layer — mutating a real logged-in tab requires a
   * per-origin grant; a sandboxed headless tab does not.
   */
  readonly controlsUserBrowser: boolean;
  /** Whether this provider can serve sessions in the current environment. */
  isAvailable(): Promise<boolean>;
  /** Create a new tab/session. Auto-assigns a browserId when omitted. */
  createSession(
    browserId?: string,
    options?: BrowserSessionOptions,
  ): Promise<{ session: BrowserSession; browserId: string }>;
  /** Look up a session by browserId. */
  getSession(browserId: string): BrowserSession | undefined;
  /**
   * Get a live session back for a `browserId` whose socket is gone but whose
   * record isn't — a reloaded desktop, an idle-swept tab, a restarted server.
   * Returns null when there is nothing to revive.
   */
  reviveSession(browserId: string): Promise<BrowserSession | null>;
  /** All open sessions, keyed by browserId. */
  getAllSessions(): Map<string, BrowserSession>;
  /** Close and remove one session. */
  closeSession(browserId: string): Promise<void>;
  /** Close all sessions (provider may keep the underlying Chrome alive for reuse). */
  closeAll(): Promise<void>;
  /** Find the session bound to a given YAAR window, if any. */
  findByWindowId(windowId: string): BrowserSession | undefined;
  /** Drain tabs auto-adopted since the last call (e.g. popups). */
  consumeAdoptedTabs(): AdoptedTab[];
  /**
   * Subscribe to tabs opening and closing. Returns the unsubscribe.
   *
   * Independent of {@link consumeAdoptedTabs}: a listener never consumes, so the
   * agent's next click still sees the popup it caused.
   */
  onTabEvent(listener: (event: BrowserTabEvent) => void): () => void;
  /**
   * Adopt every already-open page target not yet in the session map, so a
   * passive `list_tabs` reflects the browser's real tabs (including ones the
   * user opened before the agent touched the browser, like YAAR's own tab) —
   * not just the tabs YAAR created. A no-op when no endpoint is reachable;
   * never launches Chrome. Attaches passively (no navigation, no resize).
   */
  syncExistingTabs(): Promise<void>;
  /** Tear everything down — called on server exit. */
  shutdown(): Promise<void>;
  /** Snapshot of provider state for introspection. */
  getStats(): BrowserProviderStats;
  /** Per-session detail for Process Explorer and `yaar://system/browsers`. */
  listSessionInfo(): Promise<BrowserSessionInfo[]>;
}

export interface PageState {
  url: string;
  title: string;
  textSnippet: string;
  activeElement?: { tag: string; id?: string; name?: string; type?: string };
  urlChanged?: boolean;
  clickTarget?: {
    tag: string;
    text: string;
    candidateCount: number;
    selector?: string;
    href?: string;
  };
  scrollY?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  visibleLinks?: Array<{ text: string; href: string }>;
  newTab?: { browserId: string; url: string };
}

export interface PageContent {
  url: string;
  title: string;
  fullText: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; fields: Array<{ name: string; type: string; value?: string }> }>;
}
