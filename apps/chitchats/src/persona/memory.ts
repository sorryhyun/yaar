/**
 * The two memory documents — parsing `consolidated_memory.md`, appending to
 * `recent_events.md`.
 *
 * All pure text in, text out. This is where the app's one genuinely fiddly regex lives,
 * in a file with no I/O in it, so it can be reasoned about (and tested) without an
 * iframe.
 */

// ── consolidated_memory.md ────────────────────────────────────────────

export interface MemoryChunk {
  /** The `## [subtitle]` header, verbatim. What `recall` is called with. */
  subtitle: string;
  /** The chunk body with the present-day thought lifted out. */
  content: string;
  /** The `**Present thought:** "…"` line, when the chunk has one. */
  thought?: string;
}

/** `## [Anything_At_All]`. Unanchored at the end, as in the desktop app's parser. */
const SUBTITLE_RE = /^##\s*\[([^\]]+)\]/;

/**
 * The present-day thought line.
 *
 * `지금 드는 생각` is the desktop app's marker and stays canonical; the English aliases
 * are here because this port's own starter cast is written in English and a marker
 * nobody can read is a marker nobody writes. Curly quotes are accepted because a
 * document written in a word processor has them and the author will not know why their
 * thought vanished.
 */
const THOUGHT_RE =
  /\*\*\s*(?:지금 드는 생각|Present thought|Current thought)\s*:\*\*\s*["“']([^"”']*)["”']/;

function splitThought(body: string): { content: string; thought?: string } {
  const match = THOUGHT_RE.exec(body);
  if (!match) return { content: body.trim() };
  return {
    content: body
      .replace(match[0], '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    thought: match[1].trim() || undefined,
  };
}

/**
 * Split a memory document into independently retrievable chunks.
 *
 * Text before the first `## [subtitle]` is dropped — the convention's whole point is
 * that every chunk stands alone, so a preamble nothing can retrieve is a preamble that
 * would only ever be read by accident.
 */
export function parseConsolidatedMemory(markdown: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  let subtitle: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (subtitle === null) return;
    chunks.push({ subtitle, ...splitThought(body.join('\n')) });
  };

  for (const line of markdown.split('\n')) {
    const match = SUBTITLE_RE.exec(line);
    if (match) {
      flush();
      subtitle = match[1].trim();
      body = [];
    } else if (subtitle !== null) {
      body.push(line);
    }
  }
  flush();

  return chunks.filter((chunk) => !!chunk.subtitle);
}

/** One chunk by subtitle, or undefined. Case- and whitespace-insensitive on the way in. */
export function findMemory(chunks: MemoryChunk[], subtitle: string): MemoryChunk | undefined {
  const wanted = subtitle.trim().toLowerCase();
  return chunks.find((chunk) => chunk.subtitle.toLowerCase() === wanted);
}

// ── recent_events.md ────────────────────────────────────────────────

/**
 * How many rows of `recent_events.md` reach the prompt.
 *
 * The file keeps everything — it is the character's diary and pruning it is the user's
 * call — but only the tail is replayed. Unlike every other document here this one grows
 * without anybody deciding to grow it, and an unbounded section would eventually run
 * into the platform's 20k system-prompt ceiling mid-conversation, which would look like
 * the character suddenly failing to spawn for no reason the user can see.
 */
export const RECENT_EVENTS_PROMPT_ROWS = 40;

/** `YYYY-MM-DD` in local time — the date the row is stamped with. */
function isoDate(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** The row one `memorize` call becomes. Single line: a row is a one-liner or it is prose. */
export function recentEventRow(entry: string, when: Date): string {
  return `- [${isoDate(when)}] ${entry.trim().replace(/\s*\n+\s*/g, ' ')}`;
}

/** Append one row, keeping the document a plain newline-separated list. */
export function appendRecentEvent(markdown: string, entry: string, when: Date): string {
  const row = recentEventRow(entry, when);
  const body = markdown.replace(/\s+$/, '');
  return body ? `${body}\n${row}\n` : `${row}\n`;
}

/**
 * The tail of the diary, as the prompt sees it.
 *
 * Exported for `prompt.ts` only — deliberately absent from the package's barrel, because
 * it was module-private before the split and nothing outside the prompt builder has a
 * reason to know how the tail is cut.
 */
export function recentEventsTail(markdown: string): string {
  const rows = markdown
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => !!row.trim());
  return rows.slice(-RECENT_EVENTS_PROMPT_ROWS).join('\n');
}
