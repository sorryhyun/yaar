/**
 * SessionHub — singleton registry of live sessions.
 *
 * Manages the lifecycle of LiveSession instances (create, get, evict).
 * Extracted from live-session.ts for separation of concerns.
 */

import { LiveSession, type LiveSessionOptions } from './live-session.js';
import type { SessionId } from './types.js';
import { generateSessionId } from './types.js';
import type { RecoveryMode } from '@yaar/shared';
import type { AgentRole } from '../agents/agent-context.js';

/** What `attach()` did with the id the client asked for. See RecoveryMode in @yaar/shared. */
export interface AttachResult {
  session: LiveSession;
  recoveryMode: RecoveryMode;
}

export class SessionHub {
  private sessions = new Map<SessionId, LiveSession>();
  private defaultSessionId: SessionId | null = null;
  private evictionTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private agentToSession = new Map<string, SessionId>();
  private waiters = new Map<SessionId, Array<(session: LiveSession) => void>>();
  /** Ids this process has held and lost. A reconnect on one of these is a replacement, not a rejoin. */
  private evictedIds = new Set<SessionId>();

  /**
   * Resolve once `sessionId` is in the hub, or null if it hasn't arrived within
   * `timeoutMs`. An iframe app boots on its own clock and can call a session-scoped
   * verb before the desktop's WebSocket has registered the session (first load after
   * a server start) or while it is reconnecting after an eviction — the session shows
   * up under the same id milliseconds later, so callers wait for it rather than
   * failing the app's first paint. See routes/verb.ts.
   */
  waitFor(sessionId: SessionId, timeoutMs = 5_000): Promise<LiveSession | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const settle = (session: LiveSession | null) => {
        clearTimeout(timer);
        const queue = this.waiters.get(sessionId)?.filter((cb) => cb !== onCreated);
        if (queue?.length) this.waiters.set(sessionId, queue);
        else this.waiters.delete(sessionId);
        resolve(session);
      };
      const onCreated = (session: LiveSession) => settle(session);
      const timer = setTimeout(() => settle(null), timeoutMs);

      const queue = this.waiters.get(sessionId) ?? [];
      queue.push(onCreated);
      this.waiters.set(sessionId, queue);
    });
  }

  scheduleEviction(sessionId: SessionId, delayMs = 60_000): void {
    this.cancelEviction(sessionId);
    const timer = setTimeout(() => {
      this.evictionTimers.delete(sessionId);
      console.log(`[SessionHub] Evicting abandoned session: ${sessionId}`);
      this.remove(sessionId).catch((err) => {
        console.error(`[SessionHub] Failed to evict session ${sessionId}:`, err);
      });
    }, delayMs);
    this.evictionTimers.set(sessionId, timer);
  }

  registerAgent(agentId: string, sessionId: SessionId): void {
    this.agentToSession.set(agentId, sessionId);
  }

  unregisterAgent(agentId: string): void {
    this.agentToSession.delete(agentId);
  }

  cancelEviction(sessionId: SessionId): void {
    const timer = this.evictionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(sessionId);
    }
  }

  /**
   * Bind a connection's requested session id to a LiveSession, and say what that binding
   * actually is: a rejoin of the live session, or a new incarnation wearing the same id.
   *
   * `getOrCreate()` returns only the session, which cannot express the difference — the
   * caller gets a LiveSession either way and has no way to know the agents, windows, and
   * provider conversations behind it are not the ones the client left. Callers that speak
   * to a client (the WebSocket join) use this instead and forward `recoveryMode`.
   */
  attach(requestedId: string | null, options: LiveSessionOptions): AttachResult {
    // Try to find existing session
    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) {
        return { session: existing, recoveryMode: 'attached' };
      }
    }

    // Return existing default session if one exists and no specific ID was requested
    if (!requestedId && this.defaultSessionId) {
      const existing = this.sessions.get(this.defaultSessionId);
      if (existing) {
        return { session: existing, recoveryMode: 'attached' };
      }
    }

    const recoveryMode = this.classifyNewIncarnation(requestedId, options);

    // Create new session
    const sessionId = requestedId ?? generateSessionId();
    const session = new LiveSession(sessionId, options);

    this.sessions.set(sessionId, session);
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId;
    }

    console.log(
      `[SessionHub] Created session: ${sessionId} (epoch ${session.epoch}, ${recoveryMode})`,
    );

    // Release anything parked in waitFor() — typically an app's iframe whose verb
    // call beat its own desktop's WebSocket to the server.
    const waiting = this.waiters.get(sessionId);
    if (waiting) for (const notify of waiting) notify(session);

    return { session, recoveryMode };
  }

  /**
   * Why a session id resolved to a session the client has never seen.
   *
   * Eviction wins over restore: boot-time restore state is seeded into whatever session is
   * created next, so a session replaced after eviction can still come up with windows on
   * screen. Those windows are from the boot transcript, not from the incarnation the client
   * lost — calling that `restored` would overstate the continuity.
   */
  private classifyNewIncarnation(
    requestedId: string | null,
    options: LiveSessionOptions,
  ): RecoveryMode {
    if (!requestedId) return 'created';
    if (this.evictedIds.has(requestedId)) return 'replaced';

    const hasRestoredState =
      (options.restoreActions?.length ?? 0) > 0 || (options.contextMessages?.length ?? 0) > 0;
    return hasRestoredState ? 'restored' : 'replaced';
  }

  /**
   * Get an existing session or create a new one.
   *
   * Continuity-blind: prefer `attach()` on any path that reports back to a client.
   */
  getOrCreate(requestedId: string | null, options: LiveSessionOptions): LiveSession {
    return this.attach(requestedId, options).session;
  }

  get(sessionId: SessionId): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  findSessionByAgent(agentId: string): SessionId | undefined {
    return this.agentToSession.get(agentId);
  }

  findMonitorForAgent(agentId: string): string | undefined {
    for (const session of this.sessions.values()) {
      const monitorId = session.getPool()?.agentPool?.findMonitorForAgent(agentId);
      if (monitorId) return monitorId;
    }
    return undefined;
  }

  findWindowForAgent(agentId: string): string | undefined {
    for (const session of this.sessions.values()) {
      const windowId = session.getPool()?.findWindowForAgent(agentId);
      if (windowId) return windowId;
    }
    return undefined;
  }

  findRoleForAgent(agentId: string): AgentRole | undefined {
    for (const session of this.sessions.values()) {
      const role = session.getPool()?.agentPool?.getRoleForAgent(agentId);
      if (role) return role;
    }
    return undefined;
  }

  getDefault(): LiveSession | undefined {
    if (this.defaultSessionId) {
      return this.sessions.get(this.defaultSessionId);
    }
    return undefined;
  }

  /**
   * Every live session, as a snapshot — callers that tear sessions down while
   * walking must not iterate the live map.
   */
  all(): LiveSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Tear every live session down, for process shutdown.
   *
   * `shutdown()` never touched the hub, so no `LiveSession.cleanup()` ran on Ctrl-C
   * and `SessionLogger`'s debounced write buffer went with the process — every
   * launch lost whatever had not hit its flush timer. This is data loss, not a
   * process leak: the provider children die with the group either way.
   *
   * Bounded, because shutdown has a 5s force-kill deadline over it and a hung
   * provider must not be what stops the flush of every *other* session's log. A
   * session that overruns is abandoned, not awaited.
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();

    const ids = [...this.sessions.keys()];
    if (ids.length === 0) return;

    const removals = ids.map((id) =>
      this.remove(id).catch((err) => console.error(`[SessionHub] Drain failed for ${id}:`, err)),
    );
    let bell: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(removals),
      new Promise<void>((resolve) => {
        bell = setTimeout(() => {
          console.error(`[SessionHub] Drain timed out after ${timeoutMs}ms; abandoning the rest.`);
          resolve();
        }, timeoutMs);
      }),
    ]);
    clearTimeout(bell);
  }

  /**
   * Drop a session from the hub and tear it down.
   *
   * Deregistration happens in `finally`: a `cleanup()` that throws leaves a partially
   * torn-down LiveSession (listeners removed, requests rejected) and it must not stay
   * resolvable by id, or the next reconnect reattaches to a half-dead session instead
   * of getting a fresh one. The cleanup error still propagates to the caller.
   */
  async remove(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.cleanup();
    } finally {
      // Clean up reverse agent index for this session
      for (const [aid, sid] of this.agentToSession) {
        if (sid === sessionId) this.agentToSession.delete(aid);
      }
      this.sessions.delete(sessionId);
      this.evictedIds.add(sessionId);
      if (this.defaultSessionId === sessionId) {
        this.defaultSessionId = null;
      }
      console.log(`[SessionHub] Removed session: ${sessionId}`);
    }
  }
}

let hub: SessionHub | null = null;

export function getSessionHub(): SessionHub {
  if (!hub) {
    hub = new SessionHub();
  }
  return hub;
}

export function initSessionHub(): SessionHub {
  hub = new SessionHub();
  return hub;
}
