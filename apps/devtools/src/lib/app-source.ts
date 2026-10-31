export {};
import { compilePattern } from '@bundled/yaar-dev';
import { globToRegExp } from './paths';
import { clipMatchLine, GREP_LINE_CHARS } from './preview-shape';

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
  /** Up to `context` lines above the hit, nearest last. */
  before?: string[];
  /** Up to `context` lines below the hit. */
  after?: string[];
}

/** A cap on search hits, so one pattern over a large app cannot flood the reply. */
export const SOURCE_MATCH_CAP = 200;
/** One page of `files/grep`, matching the storage grep's own cap. */
export const GREP_PAGE = 100;
/** The most lines of context `files/grep` gives on each side of a hit. */
export const GREP_MAX_CONTEXT = 10;

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
 * way the project `files/grep` clips.
 */
export function searchSources(
  files: SourceFile[],
  pattern: string,
  glob?: string,
  cap = SOURCE_MATCH_CAP,
  page: { offset?: number; context?: number } = {},
): { matches: SourceMatch[]; total: number } {
  const offset = page.offset ?? 0;
  const context = page.context ?? 0;
  const compiled = compilePattern(pattern);
  if ('error' in compiled) throw new Error(compiled.error);
  const re = compiled.regex;
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
      if (total <= offset || matches.length >= cap) continue;
      matches.push({
        file: file.path,
        line: i + 1,
        content: clipMatchLine(lines[i], pattern),
        ...(context > 0
          ? {
              before: lines.slice(Math.max(0, i - context), i).map(clipContextLine),
              after: lines.slice(i + 1, i + 1 + context).map(clipContextLine),
            }
          : {}),
      });
    }
  }
  return { matches, total };
}

function clipContextLine(line: string): string {
  return line.length > GREP_LINE_CHARS
    ? `${line.slice(0, GREP_LINE_CHARS)} …[+${line.length - GREP_LINE_CHARS} chars]`
    : line;
}

/**
 * One file's hits as text: `12│hit`, `11-│context`, and `--` between runs that do not touch.
 * A line that is both a hit and another hit's context prints once, as a hit.
 */
export function formatGrepHits(matches: SourceMatch[]): string {
  const rows = new Map<number, { text: string; hit: boolean }>();
  for (const m of matches) {
    const first = m.line - (m.before?.length ?? 0);
    m.before?.forEach((text, i) => {
      if (!rows.has(first + i)) rows.set(first + i, { text, hit: false });
    });
    rows.set(m.line, { text: m.content, hit: true });
    m.after?.forEach((text, i) => {
      if (!rows.has(m.line + 1 + i)) rows.set(m.line + 1 + i, { text, hit: false });
    });
  }
  const withContext = matches.some((m) => m.before?.length || m.after?.length);
  const out: string[] = [];
  let last = 0;
  for (const [n, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    if (withContext && last > 0 && n > last + 1) out.push('--');
    out.push(`${n}${row.hit ? '' : '-'}│${row.text}`);
    last = n;
  }
  return out.join('\n');
}
