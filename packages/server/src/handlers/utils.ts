/**
 * Shared helpers used by multiple handler files.
 */

import type { VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
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

/** Create a successful JSON result (pretty-printed) */
export const okJson = (data: unknown) => ok(JSON.stringify(data, null, 2));

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
export function requireField(
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

/**
 * Parse a line range string like "10-20", "50", or "100-" into [start, end] (1-based inclusive).
 * Returns null on invalid input.
 */
function parseLineRange(range: string): [start: number, end: number | null] | null {
  const m = range.match(/^(\d+)(?:-(\d*))?$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  if (start < 1) return null;
  if (m[2] === undefined) return [start, start]; // single line "50"
  if (m[2] === '') return [start, null]; // open-ended "100-"
  const end = parseInt(m[2], 10);
  if (end < start) return null;
  return [start, end];
}

/**
 * Apply read filtering (line range and/or pattern) to raw text content.
 * Returns formatted text with line numbers, or the original content if no options apply.
 */
export function applyReadOptions(
  rawContent: string,
  filePath: string,
  options?: import('./uri-registry.js').ReadOptions,
): string {
  const lines = rawContent.split('\n');
  const totalLines = lines.length;
  const width = String(totalLines).length;
  const formatLine = (line: string, num: number) => `${String(num).padStart(width)}│${line}`;

  // No filtering — return full file with line numbers
  if (!options?.lines && !options?.pattern) {
    const numbered = lines.map((line, i) => formatLine(line, i + 1)).join('\n');
    return `── ${filePath} (${totalLines} lines) ──\n${numbered}`;
  }

  // Step 1: Apply line range filter
  let startLine = 1;
  let endLine = totalLines;
  if (options.lines) {
    const parsed = parseLineRange(options.lines);
    if (!parsed) return `Invalid line range: "${options.lines}". Use "10-20", "50", or "100-".`;
    startLine = parsed[0];
    endLine = parsed[1] ?? totalLines;
    endLine = Math.min(endLine, totalLines);
    if (startLine > totalLines) {
      return `Line ${startLine} exceeds file length (${totalLines} lines).`;
    }
  }

  // Step 2: Apply pattern filter
  if (options.pattern) {
    let regex: RegExp;
    try {
      regex = new RegExp(options.pattern);
    } catch {
      return `Invalid regex pattern: "${options.pattern}"`;
    }

    const ctx = options.context ?? 0;
    const matchedLineNums = new Set<number>();

    for (let i = startLine - 1; i < endLine; i++) {
      if (regex.test(lines[i])) {
        // Add the match and its context lines (clamped to line range)
        const ctxStart = Math.max(i - ctx, startLine - 1);
        const ctxEnd = Math.min(i + ctx, endLine - 1);
        for (let j = ctxStart; j <= ctxEnd; j++) {
          matchedLineNums.add(j);
        }
      }
    }

    if (matchedLineNums.size === 0) {
      const scope = options.lines ? ` in lines ${startLine}-${endLine}` : '';
      return `No matches for /${options.pattern}/${scope} in ${filePath}`;
    }

    // Build output with group separators
    const sorted = Array.from(matchedLineNums).sort((a, b) => a - b);
    const outputLines: string[] = [];
    for (let k = 0; k < sorted.length; k++) {
      if (k > 0 && sorted[k] - sorted[k - 1] > 1) {
        outputLines.push('──');
      }
      outputLines.push(formatLine(lines[sorted[k]], sorted[k] + 1));
    }

    const label = options.lines ? ` lines ${startLine}-${endLine}` : '';
    return `── ${filePath}${label} (${matchedLineNums.size} matching lines) ──\n${outputLines.join('\n')}`;
  }

  // Line range only (no pattern)
  const sliced = lines.slice(startLine - 1, endLine);
  const numbered = sliced.map((line, i) => formatLine(line, startLine + i)).join('\n');
  return `── ${filePath} lines ${startLine}-${endLine} of ${totalLines} ──\n${numbered}`;
}

export async function applyEdit(
  content: string,
  params: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const { old_string, new_string, start_line, end_line } = params as {
    old_string?: string;
    new_string?: string;
    start_line?: number;
    end_line?: number;
  };
  const replacement = new_string ?? (params.content as string | undefined);
  if (replacement === undefined) {
    return { error: 'Provide new_string (or content) with the replacement text.' };
  }

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
    return { result: content.replace(old_string, replacement) };
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
  return { result: [...before, replacement, ...after].join('\n') };
}
