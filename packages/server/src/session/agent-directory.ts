/**
 * Which session each live agent belongs to — the reverse index an MCP request resolves its
 * caller's session through (`SessionHub.findSessionByAgent`).
 *
 * A leaf, and outside `SessionHub`, on purpose. The writers are the agent pools, reached
 * through the `PoolHost` their `LiveSession` hands them; when the map lived on the hub,
 * writing it meant `agents/` importing `session-hub`, which imports `live-session`, which
 * imports `context-pool` — a runtime cycle. `LiveSession` cannot import the hub either
 * (the hub imports it), so the index sits below both, and each of them reaches it directly.
 *
 * Not reset by `initSessionHub()`: agent ids are minted unique (`genId`), so an entry
 * outliving the hub it was registered under can only ever answer for its own agent.
 */

import type { SessionId } from './types.js';

const agentToSession = new Map<string, SessionId>();

export const agentDirectory = {
  register(agentId: string, sessionId: SessionId): void {
    agentToSession.set(agentId, sessionId);
  },

  unregister(agentId: string): void {
    agentToSession.delete(agentId);
  },

  sessionOf(agentId: string): SessionId | undefined {
    return agentToSession.get(agentId);
  },

  /** Backstop for a session torn down with ids its pool never untracked. */
  forgetSession(sessionId: SessionId): void {
    for (const [agentId, owner] of agentToSession) {
      if (owner === sessionId) agentToSession.delete(agentId);
    }
  },
};
