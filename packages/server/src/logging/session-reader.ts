import { readdir } from 'fs/promises';
import { join } from 'path';
import { SESSIONS_DIR, ensureSessionsDir } from './index.js';
import type { SessionInfo, SessionMetadata, ParsedMessage } from './types.js';

/**
 * List all sessions.
 *
 * `dir` defaults to the real `session_logs/`; it is a parameter so a test can point the
 * read side at a temp directory of its own rather than at the one every suite in the
 * process shares.
 */
export async function listSessions(dir: string = SESSIONS_DIR): Promise<SessionInfo[]> {
  if (dir === SESSIONS_DIR) await ensureSessionsDir();

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(dir, entry.name);
    const metadataPath = join(directory, 'metadata.json');

    try {
      const metadataContent = await Bun.file(metadataPath).text();
      const rawMetadata = JSON.parse(metadataContent);

      const metadata: SessionMetadata = rawMetadata;

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
  sessions.sort(
    (a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime(),
  );

  return sessions;
}

/**
 * Read session messages.
 */
export async function readSessionMessages(
  sessionId: string,
  dir: string = SESSIONS_DIR,
): Promise<string | null> {
  const messagesPath = join(dir, sessionId, 'messages.jsonl');

  try {
    return await Bun.file(messagesPath).text();
  } catch {
    return null;
  }
}

/**
 * Parse session messages from JSONL format.
 */
export function parseSessionMessages(messagesJsonl: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = messagesJsonl.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ParsedMessage;
      messages.push(parsed);
    } catch {
      // Skip invalid lines
    }
  }

  return messages;
}

/**
 * Read a session transcript (generated from messages.jsonl).
 */
export async function readSessionTranscript(sessionId: string): Promise<string | null> {
  const messagesJsonl = await readSessionMessages(sessionId);
  if (messagesJsonl === null) return null;

  const messages = parseSessionMessages(messagesJsonl);
  const lines: string[] = ['# Session Transcript\n'];

  for (const msg of messages) {
    const ts = msg.timestamp;
    switch (msg.type) {
      case 'user':
        lines.push(`## User → ${msg.agentId} (${ts})\n\n${msg.content ?? ''}\n`);
        break;
      case 'assistant':
        lines.push(`## ${msg.agentId} (${ts})\n\n${msg.content ?? ''}\n`);
        break;
      case 'tool_use':
        lines.push(
          `### Tool: ${msg.toolName} (${ts})\n\n\`\`\`json\n${JSON.stringify(msg.toolInput, null, 2)}\n\`\`\`\n`,
        );
        break;
      case 'tool_result': {
        const body =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content != null
              ? JSON.stringify(msg.content, null, 2)
              : '';
        lines.push(`### Result: ${msg.toolName} (${ts})\n\n${body}\n`);
        break;
      }
      case 'action':
        lines.push(`### Action: ${msg.action?.type} (${ts})\n`);
        break;
    }
  }

  return lines.join('\n');
}
