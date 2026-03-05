/**
 * Session types for multi-client session support.
 */

import type { OSAction, SessionId } from '@yaar/shared';

// Re-export from shared for backward compatibility
export type { SessionId } from '@yaar/shared';

/** Snapshot of current session state for new connections. */
export interface SessionSnapshot {
  actions: OSAction[];
}

/** Generate a unique session ID. */
export function generateSessionId(): SessionId {
  return `ses-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
