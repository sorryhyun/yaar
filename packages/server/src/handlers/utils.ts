/**
 * Shared helpers used by multiple handler files: session access and URI/payload checks.
 *
 * Result builders (`ok`, `okJson`, `error`, …) and `VerbResult` live in lib/verb-result.ts,
 * and the read filters in lib/read-options.ts — leaves that do not reach the session hub.
 */

import { error, type VerbResult } from '../lib/verb-result.js';
import type { ResolvedUri } from './uri-resolve.js';
import { getSessionId } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import type { LiveSession } from '../session/live-session.js';
import type { SessionId } from '../session/types.js';
import type { ContextPool } from '../agents/context-pool.js';
import { MIME_TYPES } from '../config.js';
import { extname } from 'path';

/**
 * Thrown when the caller names a session the hub doesn't hold. This is transient,
 * not fatal: an iframe app boots with a token minted for a session whose WebSocket
 * has yet to connect (or was evicted 60s after its last one closed), and the session
 * reappears under the same id as soon as the frontend (re)connects. Callers that
 * turn verbs into HTTP — see routes/verb.ts — surface it as a retryable 503 rather
 * than a 500.
 */
export class NoActiveSessionError extends Error {
  constructor() {
    super('No active session — connect via WebSocket first.');
    this.name = 'NoActiveSessionError';
  }
}

/** Get the active LiveSession (from agent context or default). */
export function getActiveSession(): LiveSession {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  if (!session) throw new NoActiveSessionError();
  return session;
}

/**
 * Resolve the id of the session a call belongs to — agent context first, the default
 * session as the fallback for a call made outside a turn.
 *
 * Deliberately *not* `getActiveSession().sessionId`: this answers "whose session is this
 * call for?" without requiring the hub to still hold that session, and never throws.
 * Callers that need the live session itself should use `getActiveSession()`.
 */
export function getActiveSessionId(): SessionId | undefined {
  return getSessionId() ?? getSessionHub().getDefault()?.sessionId;
}

/** Get the ContextPool from the active session. */
export function getActivePool(): ContextPool | null {
  return getActiveSession().getPool();
}

/**
 * Validate that a path is relative and doesn't contain traversal segments.
 * Returns an error message string if invalid, null if valid.
 */
export function validateRelativePath(path: string): string | null {
  if (path.includes('..') || path.startsWith('/')) {
    return 'Invalid path. Use relative paths without ".." or leading "/".';
  }
  return null;
}

/** Infer MIME type from a file path extension. Falls back to 'text/plain'. */
export function mimeFromPath(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'text/plain';
}

/** Extract the first path segment after `yaar://{authority}/`. */
export function extractIdFromUri(uri: string, authority: string): string {
  const match = uri.match(new RegExp(`^yaar://${authority}/([^/]+)`));
  return match?.[1] ?? '';
}

/** Assert that a resolved URI matches the expected kind. */
export function assertUri<K extends ResolvedUri['kind']>(
  resolved: ResolvedUri,
  kind: K,
): asserts resolved is Extract<ResolvedUri, { kind: K }> {
  if (resolved.kind !== kind) throw new Error(`Expected ${kind} URI, got ${resolved.kind}`);
}

/** Check that payload contains a required field. Returns error VerbResult if missing, null if present. */
function requireField(
  payload: Record<string, unknown> | undefined,
  field: string,
  context?: string,
): VerbResult | null {
  if (!payload?.[field]) {
    const suffix = context ? ` for ${context}` : '';
    return error(`"${field}" is required${suffix}.`);
  }
  return null;
}

/** Check that payload includes an "action" field. Returns error VerbResult if missing, null if present. */
export function requireAction(payload?: Record<string, unknown>): VerbResult | null {
  return requireField(payload, 'action', undefined)
    ? error('Payload must include "action".')
    : null;
}
