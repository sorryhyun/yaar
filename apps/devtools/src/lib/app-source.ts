export {};
import { globToRegExp } from './paths';
import { clipMatchLine } from './preview-shape';
import { compileSearchPattern } from './search-pattern';

// Pure: reading an installed app's source as it arrives from the server's clone verb —
// a flat list of files held in memory, never written into a project.

export interface SourceFile {
  path: string;
  content: string;
  /** Set when `content` is base64: the bytes are not text. */
  encoding?: 'base64';
}

export interface SourceMatch {
  file: string;
  line: number;
  content: string;
}

/** A cap on search hits, so one pattern over a large app cannot flood the reply. */
export const SOURCE_MATCH_CAP = 200;

/** Lines in a text, counting a final line with no newline and not counting a trailing one. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Lines `start`..`end` (1-based, inclusive) of `text`, clamped to the file. Either bound may
 * be omitted. Answers the slice and the range it actually covers.
 */
export function sliceLines(
  text: string,
  start?: number,
  end?: number,
): { content: string; from: number; to: number } {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const from = Math.max(1, Math.floor(start ?? 1));
  const to = Math.min(lines.length, Math.floor(end ?? lines.length));
  return { content: lines.slice(from - 1, to).join('\n'), from, to };
}

/**
 * Regex search over in-memory files, text only, in path order. A `glob` narrows the files;
 * hits past `cap` are counted, not listed, and each line is clipped around its match the
 * way the project `grep` clips.
 */
export function searchSources(
  files: SourceFile[],
  pattern: string,
  glob?: string,
  cap = SOURCE_MATCH_CAP,
): { matches: SourceMatch[]; total: number } {
  const re = compileSearchPattern(pattern);
  const only = glob ? globToRegExp(glob) : null;
  const matches: SourceMatch[] = [];
  let total = 0;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (file.encoding || (only && !only.test(file.path))) continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (matches.length < cap) {
        matches.push({ file: file.path, line: i + 1, content: clipMatchLine(lines[i], pattern) });
      }
    }
  }
  return { matches, total };
}
