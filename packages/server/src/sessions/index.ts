/**
 * Session logging for ClaudeOS.
 *
 * Logs session activity to disk for debugging and replay purposes.
 * Sessions are stored in session_logs/{timestamp}/
 */

import { mkdir, writeFile, readFile, readdir, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OSAction } from '@claudeos/shared';

// Project root directory (3 levels up from this file: sessions -> src -> server -> packages -> root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const SESSIONS_DIR = join(PROJECT_ROOT, 'session_logs');

export interface SessionMetadata {
  createdAt: string;
  provider: string;
  lastActivity: string;
}

export interface SessionInfo {
  sessionId: string;
  directory: string;
  metadata: SessionMetadata;
}

/**
 * Ensure the sessions directory exists.
 */
async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Generate a unique session ID based on timestamp.
 */
function generateSessionId(): string {
  // Format: YYYY-MM-DD_HH-MM-SS
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `${date}_${time}`;
}

/**
 * Create a new session.
 */
export async function createSession(provider: string): Promise<SessionInfo> {
  await ensureSessionsDir();

  const sessionId = generateSessionId();
  const directory = join(SESSIONS_DIR, sessionId);

  await mkdir(directory, { recursive: true });

  const metadata: SessionMetadata = {
    createdAt: new Date().toISOString(),
    provider,
    lastActivity: new Date().toISOString(),
  };

  await writeFile(
    join(directory, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // Create empty files
  await writeFile(join(directory, 'transcript.md'), '');
  await writeFile(join(directory, 'messages.jsonl'), '');

  return { sessionId, directory, metadata };
}

/**
 * Session logger for recording session activity.
 */
export class SessionLogger {
  private sessionInfo: SessionInfo;

  constructor(sessionInfo: SessionInfo) {
    this.sessionInfo = sessionInfo;
  }

  /**
   * Log a user message.
   */
  async logUserMessage(content: string): Promise<void> {
    const timestamp = new Date().toISOString();

    // Append to transcript
    await appendFile(
      join(this.sessionInfo.directory, 'transcript.md'),
      `\n## User (${timestamp})\n\n${content}\n`
    );

    // Append to messages log
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'user', timestamp, content }) + '\n'
    );
  }

  /**
   * Log an assistant message.
   */
  async logAssistantMessage(content: string): Promise<void> {
    const timestamp = new Date().toISOString();

    // Append to transcript
    await appendFile(
      join(this.sessionInfo.directory, 'transcript.md'),
      `\n## Assistant (${timestamp})\n\n${content}\n`
    );

    // Append to messages log
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp, content }) + '\n'
    );
  }

  /**
   * Log an OS action.
   */
  async logAction(action: OSAction): Promise<void> {
    const timestamp = new Date().toISOString();

    // Append to messages log
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'action', timestamp, action }) + '\n'
    );
  }

  /**
   * Update the last activity timestamp.
   */
  async updateLastActivity(): Promise<void> {
    this.sessionInfo.metadata.lastActivity = new Date().toISOString();

    await writeFile(
      join(this.sessionInfo.directory, 'metadata.json'),
      JSON.stringify(this.sessionInfo.metadata, null, 2)
    );
  }
}

/**
 * List all sessions.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  await ensureSessionsDir();

  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(SESSIONS_DIR, entry.name);
    const metadataPath = join(directory, 'metadata.json');

    try {
      const metadataContent = await readFile(metadataPath, 'utf-8');
      const metadata: SessionMetadata = JSON.parse(metadataContent);
      sessions.push({
        sessionId: entry.name,
        directory,
        metadata,
      });
    } catch {
      // Skip invalid sessions
    }
  }

  // Sort by creation date, newest first
  sessions.sort((a, b) =>
    new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()
  );

  return sessions;
}

/**
 * Read a session transcript.
 */
export async function readSessionTranscript(sessionId: string): Promise<string | null> {
  const transcriptPath = join(SESSIONS_DIR, sessionId, 'transcript.md');

  try {
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read session messages.
 */
export async function readSessionMessages(sessionId: string): Promise<string | null> {
  const messagesPath = join(SESSIONS_DIR, sessionId, 'messages.jsonl');

  try {
    return await readFile(messagesPath, 'utf-8');
  } catch {
    return null;
  }
}
