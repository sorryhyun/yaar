/**
 * The read verb's filters (`lines`, `pattern`, `chars`) and the `edit` action's text splice —
 * pure text transforms, shared by every door that serves a file or a value (storage, app
 * storage, window state, app-protocol reads) and by the result spill that pages an
 * oversized result back. A leaf beside `verb-result.ts` so `features/` can apply them
 * without importing from `handlers/`.
 */

import { searchValuePaths } from './state-path.js';

/** Optional filtering params for the read verb (ripgrep-style). */
export interface ReadOptions {
  /** Line range to read, e.g. "10-20" or "50" (1-based, inclusive). */
  lines?: string;
  /** Regex pattern to filter matching lines. */
  pattern?: string;
  /** Number of context lines around pattern matches (default: 0). */
  context?: number;
  /**
   * Character range to read, e.g. "0-50000" or "150000-" (0-based offset, end exclusive —
   * `String.slice`). The only filter that can page a file that is one huge line: `lines`
   * and `pattern` both hand back whole lines. Exclusive with `lines`/`pattern`.
   */
  chars?: string;
  /**
   * PDF only: extract the text layer. `true` (or "all") reads the whole document; a range
   * string like "1-3" scopes it. Cheapest way to read a text-based PDF.
   */
  pdfText?: boolean | string;
  /**
   * PDF page range to rasterize to images, e.g. "1-3", "5", "2-" (1-based, inclusive) — for
   * scanned/visual PDFs or when layout matters. Omit both pdfText and pdfPages to get document
   * metadata plus a hint to open the PDF in a viewer window — reading a PDF should not ingest
   * its content unless the agent explicitly asks.
   */
  pdfPages?: string;
  /**
   * Images only: return the stored bytes as-is instead of the WebP re-encode a read
   * normally applies before the image enters the context. For when the pixels are the
   * subject rather than the content.
   */
  rawImage?: boolean;
  /**
   * Answer an absent resource with `null` instead of an error.
   *
   * The caller is declaring that absence is an expected state — `appStorage.readJsonOr`
   * is exactly this declaration, and without a way to send it every optional config file
   * an app reads manufactured a failure underneath the fallback that handled it.
   *
   * A resource whose stored content is literally `null` is indistinguishable from an
   * absent one through this option. Callers that must tell them apart should `list` the
   * parent instead.
   */
  missingOk?: boolean;
}

/**
 * True when a read asked for line filtering — `context` alone filters nothing.
 *
 * The read tool offers `lines`/`pattern` on every URI, but only some resources hold text a
 * line filter means anything on. A handler that applies it marks the result `readFiltered`;
 * one that cannot leaves the flag off, and `ResourceRegistry.execute` notes that the filter
 * was ignored. It used to be dropped in silence: a pattern read of an 80 KB window state
 * came back whole, indistinguishable from a read where every line matched.
 */
export function hasLineFilter(options?: ReadOptions): boolean {
  return Boolean(options?.lines || options?.pattern || options?.chars);
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
 * Slice `rawContent` by a `chars` range — "30000-60000" (0-based, end exclusive), "50000"
 * (from there to the end is too easy to overflow with, so a bare number is the *start* of a
 * default-sized page), or "150000-".
 *
 * Unnumbered on purpose: the slice is raw text a caller stitches back together, and a
 * line-number gutter would land mid-sentence on a file that is one line.
 */
function applyCharRange(rawContent: string, filePath: string, range: string): string {
  const m = range.match(/^(\d+)(?:-(\d*))?$/);
  if (!m) return `Invalid char range: "${range}". Use "0-50000", "50000-100000", or "150000-".`;
  const total = rawContent.length;
  const start = parseInt(m[1], 10);
  const end =
    m[2] === undefined
      ? Math.min(start + CHAR_PAGE_SIZE, total)
      : m[2] === ''
        ? total
        : Math.min(parseInt(m[2], 10), total);
  if (start >= total)
    return `Char offset ${start} is past the end of ${filePath} (${total} chars).`;
  if (end <= start) return `Invalid char range: "${range}" — end must be greater than start.`;
  const more =
    end < total ? ` — next: chars "${end}-${Math.min(end + CHAR_PAGE_SIZE, total)}"` : '';
  return `── ${filePath} chars ${start}-${end} of ${total}${more} ──\n${rawContent.slice(start, end)}`;
}

/**
 * The page a `chars` read steps by. Well under `MCP_MAX_RESULT_CHARS` (150,000) even after
 * the result's JSON serialization escapes every quote and newline in the slice.
 */
export const CHAR_PAGE_SIZE = 50_000;

/**
 * {@link applyReadOptions} for a value that is not a file — a window's state, say.
 *
 * A string is filtered as it is. A `pattern` alone over anything else is a path search
 * (`searchValuePaths`): one `path: value` line per leaf, so a match says where it is and
 * the pattern is not written against JSON punctuation the model never saw. `lines` (with
 * or without `pattern`) and `chars` filter *indented* JSON whatever its size, overriding
 * `jsonText`: compact JSON is one line, and a line filter over one line returns all
 * of it or nothing.
 */
export function applyReadOptionsToValue(
  value: unknown,
  label: string,
  options?: ReadOptions,
  /** Whether `label` accepts a path after it — see `searchValuePaths`. */
  addressable = false,
): string {
  if (typeof value !== 'string' && options?.pattern && !options.lines && !options.chars) {
    return searchValuePaths(value, label, options.pattern, options.context ?? 0, addressable);
  }
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  return applyReadOptions(text, label, options);
}

/**
 * Apply read filtering (line range and/or pattern) to raw text content.
 * Returns formatted text with line numbers, or the original content if no options apply.
 */
export function applyReadOptions(
  rawContent: string,
  filePath: string,
  options?: ReadOptions,
): string {
  if (options?.chars) {
    if (options.lines || options.pattern) {
      return 'chars cannot be combined with lines or pattern — use one filter per read.';
    }
    return applyCharRange(rawContent, filePath, options.chars);
  }

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
