/**
 * Session logging for YAAR.
 *
 * Logs session activity to disk for debugging and replay purposes.
 * Sessions are stored in session_logs/{timestamp}/
 */

import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Project root directory (3 levels up from this file: logging -> src -> server -> packages -> root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
export const SESSIONS_DIR = join(PROJECT_ROOT, 'session_logs');

export async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

// Re-exports
export type { AgentInfo, SessionMetadata, SessionInfo, ParsedMessage } from './types.js';
export { createSession, SessionLogger } from './session-logger.js';
export { listSessions, readSessionTranscript, readSessionMessages, parseSessionMessages } from './session-reader.js';
export { getWindowRestoreActions } from './window-restore.js';
