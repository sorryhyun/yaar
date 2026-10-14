export {};

// What `cloneApp` answers with in place of the clone's contents: a map to read from, not
// the territory. A clone of music-maker used to hand back its 44KB AGENTS.md inlined and an
// unsized list of 166 paths — ~12k tokens before debugging began, of which a trace used
// ~2KB. Everything here is pure, so the `clone-summary` suite pins it without a project.

export interface MarkdownHeading {
  /** The heading line as written, `#`s included, so the level reads at a glance. */
  heading: string;
  /** 1-based line of the heading. */
  line: number;
  /** Lines in the section: the heading through the line before the next heading of its level or higher. */
  lines: number;
}

interface ParsedHeading {
  level: number;
  text: string;
  line: number;
}

/** ATX headings outside fenced code blocks — a `#` comment in a shell snippet is not a heading. */
function parseHeadings(text: string): { headings: ParsedHeading[]; total: number } {
  const rows = text.split('\n');
  const headings: ParsedHeading[] = [];
  let fence: string | null = null;
  rows.forEach((row, i) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(row);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(row);
    if (m) headings.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  // A trailing newline is not a line of its own.
  const total = text.endsWith('\n') ? rows.length - 1 : rows.length;
  return { headings, total };
}

/** Where the section opened by `headings[index]` ends (1-based, inclusive). */
function sectionEnd(headings: ParsedHeading[], index: number, total: number): number {
  const { level } = headings[index];
  const next = headings.slice(index + 1).find((h) => h.level <= level);
  return next ? next.line - 1 : total;
}

/** The headings of a Markdown document down to `maxLevel`, each with its section's span. */
export function markdownOutline(text: string, maxLevel = 3): MarkdownHeading[] {
  const { headings, total } = parseHeadings(text);
  return headings.flatMap((h, i) =>
    h.level > maxLevel
      ? []
      : [
          {
            heading: `${'#'.repeat(h.level)} ${h.text}`,
            line: h.line,
            lines: sectionEnd(headings, i, total) - h.line + 1,
          },
        ],
  );
}

export type SectionLookup =
  | { startLine: number; endLine: number; heading: string }
  | { error: string };

/**
 * The line range of the section whose heading matches `query`: an exact match on the
 * heading text (no `#`s, case-insensitive) wins, else the one heading containing it.
 * Two containing it and none exact is refused with both named, never a guess.
 */
export function markdownSection(text: string, query: string): SectionLookup {
  const { headings, total } = parseHeadings(text);
  const want = query
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase();
  if (!want) return { error: 'section is empty' };
  const exact = headings.findIndex((h) => h.text.toLowerCase() === want);
  const partial = headings.flatMap((h, i) => (h.text.toLowerCase().includes(want) ? [i] : []));
  const index = exact !== -1 ? exact : partial.length === 1 ? partial[0] : -1;
  if (index === -1) {
    const named = (partial.length ? partial.map((i) => headings[i]) : headings)
      .slice(0, 12)
      .map((h) => `"${h.text}" (line ${h.line})`)
      .join(', ');
    return {
      error:
        partial.length > 1
          ? `section "${query}" matches ${partial.length} headings: ${named} — pass one whole`
          : headings.length
            ? `no heading matches "${query}". Headings: ${named}`
            : 'the file has no Markdown headings',
    };
  }
  const h = headings[index];
  return {
    startLine: h.line,
    endLine: sectionEnd(headings, index, total),
    heading: `${'#'.repeat(h.level)} ${h.text}`,
  };
}

export interface SizedFile {
  path: string;
  isDirectory?: boolean;
  lines?: number;
  bytes?: number;
}

export interface Rollup {
  files: number;
  lines: number;
  bytes: number;
}

export interface FilesSummary {
  size: Rollup & { largest: { path: string; lines?: number; bytes: number }[] };
  /** Per directory, rolled up to two levels (`src/engine` counts `src/engine/fx/*` too); `.` is the root. */
  tree: Record<string, Rollup>;
}

const TREE_DEPTH = 2;

/** Totals, the five largest files, and a per-directory rollup of a project listing. */
export function summarizeFiles(entries: SizedFile[], largestCount = 5): FilesSummary {
  const files = entries.filter((f) => !f.isDirectory);
  const add = (into: Rollup, f: SizedFile) => {
    into.files += 1;
    into.lines += f.lines ?? 0;
    into.bytes += f.bytes ?? 0;
  };
  const total: Rollup = { files: 0, lines: 0, bytes: 0 };
  const tree: Record<string, Rollup> = {};
  for (const f of files) {
    add(total, f);
    const dirs = f.path.split('/').slice(0, -1);
    const key = dirs.length ? dirs.slice(0, TREE_DEPTH).join('/') : '.';
    add((tree[key] ??= { files: 0, lines: 0, bytes: 0 }), f);
  }
  const largest = [...files]
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, largestCount)
    .map((f) => ({
      path: f.path,
      ...(f.lines !== undefined ? { lines: f.lines } : {}),
      bytes: f.bytes ?? 0,
    }));
  const sortedTree = Object.fromEntries(
    Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { size: { ...total, largest }, tree: sortedTree };
}

export interface ProtocolSourceLocation {
  file: string;
  line: number;
}

/** `{ file: { name: line } }` — one key per file, so a reader scans by file and the map stays small. */
export function groupByFile(
  locations: Record<string, ProtocolSourceLocation>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const sorted = Object.entries(locations).sort(
    ([, a], [, b]) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  for (const [name, loc] of sorted) (out[loc.file] ??= {})[name] = loc.line;
  return out;
}
