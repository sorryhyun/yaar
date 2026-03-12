/**
 * Shared helpers used by multiple handler files.
 */

import type { VerbResult } from './uri-registry.js';
import { getSessionId } from '../agents/session.js';
import { getSessionHub } from '../session/session-hub.js';
import type { LiveSession } from '../session/live-session.js';
import type { ContextPool } from '../agents/context-pool.js';

/** Get the active LiveSession (from agent context or default). */
export function getActiveSession(): LiveSession {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  if (!session) throw new Error('No active session — connect via WebSocket first.');
  return session;
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

/** Create a successful text result */
export const ok = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

/** Create an error text result (sets isError: true) */
export const error = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

/** Create a result with text and images */
export const okWithImages = (text: string, images: Array<{ data: string; mimeType: string }>) => ({
  content: [
    { type: 'text' as const, text },
    ...images.map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType,
    })),
  ],
});

/** Prepend a note to a VerbResult (for read/list fallback). */
export function prependNote(result: VerbResult, note: string): VerbResult {
  return { ...result, content: [{ type: 'text', text: `(${note})` }, ...result.content] };
}

export async function applyEdit(
  content: string,
  params: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const { old_string, new_string, start_line, end_line } = params as {
    old_string?: string;
    new_string: string;
    start_line?: number;
    end_line?: number;
  };

  if (old_string !== undefined && start_line !== undefined) {
    return {
      error: 'Provide either old_string (string mode) or start_line (line mode), not both.',
    };
  }
  if (old_string === undefined && start_line === undefined) {
    return { error: 'Provide old_string (string mode) or start_line (line mode).' };
  }

  if (old_string !== undefined) {
    if (!content.includes(old_string)) {
      return {
        error: 'old_string not found in file. Make sure it matches exactly (including whitespace).',
      };
    }
    const count = content.split(old_string).length - 1;
    if (count > 1) {
      return {
        error: `old_string found ${count} times. Provide more surrounding context to make it unique.`,
      };
    }
    return { result: content.replace(old_string, new_string) };
  }

  // Line mode
  const lines = content.split('\n');
  const endLine = end_line ?? start_line!;

  if (start_line! > lines.length) {
    return { error: `start_line ${start_line} exceeds file length (${lines.length} lines).` };
  }
  if (endLine > lines.length) {
    return { error: `end_line ${endLine} exceeds file length (${lines.length} lines).` };
  }
  if (endLine < start_line!) {
    return { error: 'end_line must be >= start_line.' };
  }

  const before = lines.slice(0, start_line! - 1);
  const after = lines.slice(endLine);
  return { result: [...before, new_string, ...after].join('\n') };
}
