import { readdir } from 'fs/promises';
import { join } from 'path';
import { SESSIONS_DIR, ensureSessionsDir } from './index.js';
import type { SessionInfo, SessionMetadata, ParsedMessage } from './types.js';
import { blobPath, isBlobRef } from './blobs.js';

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
 * Read one blob from a session's content-addressed store.
 *
 * `sha256` is validated as a hex digest before it becomes a path segment — it arrives
 * from a URI, and a name that is not exactly a digest is the only way this could
 * traverse out of the session directory.
 */
export async function readSessionBlob(
  sessionId: string,
  sha256: string,
  dir: string = SESSIONS_DIR,
): Promise<string | null> {
  if (!isBlobRef(sha256)) return null;

  try {
    const file = Bun.file(blobPath(join(dir, sessionId), sha256));
    return (await file.exists()) ? await file.text() : null;
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
 * Body of a result entry for the transcript.
 *
 * A transcript is a skim of the session, so an offloaded result renders as its preview
 * and a pointer rather than pulling megabytes back in — a reader that wants the bytes
 * reads the `yaar://history/{id}/blobs/{sha256}` this names.
 */
function renderResultBody(msg: ParsedMessage): string {
  if (msg.contentRef) {
    const { sha256, bytes, mimeType, preview } = msg.contentRef;
    const head = `_${mimeType ?? 'content'}, ${bytes} bytes → blobs/${sha256}_`;
    return preview ? `${head}\n\n${preview}` : head;
  }
  if (typeof msg.content === 'string') return msg.content;
  return msg.content != null ? JSON.stringify(msg.content, null, 2) : '';
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
      case 'tool_result':
      case 'verb_result': {
        const label = msg.type === 'verb_result' ? 'Verb result' : 'Result';
        lines.push(`### ${label}: ${msg.toolName} (${ts})\n\n${renderResultBody(msg)}\n`);
        break;
      }
      case 'action':
        lines.push(`### Action: ${msg.action?.type} (${ts})\n`);
        break;
    }
  }

  return lines.join('\n');
}
