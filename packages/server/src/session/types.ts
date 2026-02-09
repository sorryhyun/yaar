/**
 * Session types for multi-client session support.
 */

import type { OSAction } from '@yaar/shared';

/** Unique session identifier. */
export type SessionId = string;

/** Snapshot of current session state for new connections. */
export interface SessionSnapshot {
  actions: OSAction[];
}

/** Generate a unique session ID. */
export function generateSessionId(): SessionId {
  return `ses-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
