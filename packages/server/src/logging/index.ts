/**
 * Session logging for YAAR.
 *
 * Logs session activity to disk for debugging and replay purposes.
 * Sessions are stored in session_logs/{timestamp}/
 */

import { mkdir } from 'fs/promises';
import { getSessionLogsDir } from '../config.js';

export const SESSIONS_DIR = getSessionLogsDir();

export async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

// Re-exports
export type { AgentInfo, SessionMetadata, SessionInfo, ParsedMessage } from './types.js';
export { createSession, SessionLogger } from './session-logger.js';
export { pruneEmptySessions } from './prune.js';
export type { PruneOptions } from './prune.js';
export { findRestorableSession } from './restore-source.js';
export type { RestoreSource } from './restore-source.js';
export {
  listSessions,
  readSessionTranscript,
  readSessionMessages,
  parseSessionMessages,
} from './session-reader.js';
export { getWindowRestoreActions, refreshRestoredWindowActions } from './window-restore.js';
export { getContextRestoreMessages, FULL_RESTORE_POLICY } from './context-restore.js';
export type { ContextRestorePolicy } from './context-restore.js';
export { getCliRestoreEntries } from './cli-restore.js';
