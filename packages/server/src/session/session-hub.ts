/**
 * SessionHub — singleton registry of live sessions.
 *
 * Manages the lifecycle of LiveSession instances (create, get, evict).
 * Extracted from live-session.ts for separation of concerns.
 */

import { LiveSession, type LiveSessionOptions } from './live-session.js';
import type { SessionId } from './types.js';
import { generateSessionId } from './types.js';

export class SessionHub {
  private sessions = new Map<SessionId, LiveSession>();
  private defaultSessionId: SessionId | null = null;
  private evictionTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private agentToSession = new Map<string, SessionId>();

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
   * Get an existing session or create a new one.
   * If requestedId matches an existing session, returns it.
   * Otherwise creates a new session with the provided options.
   */
  getOrCreate(requestedId: string | null, options: LiveSessionOptions): LiveSession {
    // Try to find existing session
    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) {
        return existing;
      }
    }

    // Return existing default session if one exists and no specific ID was requested
    if (!requestedId && this.defaultSessionId) {
      const existing = this.sessions.get(this.defaultSessionId);
      if (existing) {
        return existing;
      }
    }

    // Create new session
    const sessionId = requestedId ?? generateSessionId();
    const session = new LiveSession(sessionId, options);

    this.sessions.set(sessionId, session);
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId;
    }

    console.log(`[SessionHub] Created session: ${sessionId}`);
    return session;
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

  getDefault(): LiveSession | undefined {
    if (this.defaultSessionId) {
      return this.sessions.get(this.defaultSessionId);
    }
    return undefined;
  }

  async remove(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.cleanup();
      // Clean up reverse agent index for this session
      for (const [aid, sid] of this.agentToSession) {
        if (sid === sessionId) this.agentToSession.delete(aid);
      }
      this.sessions.delete(sessionId);
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
