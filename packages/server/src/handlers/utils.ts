/**
 * Shared helpers used by multiple handler files.
 */

import type { VerbResult } from './uri-registry.js';

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
