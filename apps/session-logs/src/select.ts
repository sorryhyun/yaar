/**
 * Turn selection — the agent's window onto a loaded session.
 *
 * The app holds the whole session in memory because the *UI* needs it: the
 * transcript pane scrolls 6874 rows and every one has to be there. An agent
 * reading the same array is a different problem — it pays for every entry it
 * receives, and it wants six of them.
 *
 * So the agent's surface is not the array. It is an **index** (what is in here,
 * by type, agent and tool) plus a **slice** (give me turns 400-440, or every
 * failed `read`), and results are addressed by their position in the unfiltered
 * array so a hit can be re-read with its neighbours.
 *
 * Pure: no DOM, no store, no verbs. Everything here is a function of the parsed
 * messages, which is what makes it testable from a temporary command (see
 * AGENTS.md "Testing").
 */

import type { ParsedMessage } from './types';

/** Coerce anything to a string before string methods touch it. See summarize.ts's `str`. */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** Clip to a budget, reporting whether anything was lost. */
function clip(input: unknown, max: number): { text: string; truncated: boolean } {
  const s = str(input);
  if (max <= 0 || s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}…`, truncated: true };
}

export interface TurnFilter {
  /** Entry types to keep, e.g. `['tool_use', 'tool_result']`. Empty/absent keeps all. */
  types?: string[];
  /** Exact agent id. */
  agentId?: string;
  /** Tool name, matched as a case-insensitive substring — `read` finds `mcp__verbs__read`. */
  toolName?: string;
  /** Case-insensitive substring over content, tool input, interaction and blob preview. */
  search?: string;
  /** Only entries flagged as errors, or whose content reads like one. */
  errorsOnly?: boolean;
  /** Only entries whose result was offloaded to the blob store. */
  blobsOnly?: boolean;
}

/** One entry paired with its position in the unfiltered array — the address to re-read by. */
export interface IndexedTurn {
  index: number;
  msg: ParsedMessage;
}

/** Text a `search` should be able to match, concatenated once per entry. */
function haystack(m: ParsedMessage): string {
  return [
    m.content,
    m.interaction,
    m.toolName,
    m.source,
    m.contentRef?.preview,
    m.toolInput == null ? '' : str(m.toolInput),
    m.action == null ? '' : str(m.action),
  ]
    .map(str)
    .join('\n')
    .toLowerCase();
}

/**
 * Does this entry look like a failure?
 *
 * `isError` is authoritative when the runtime set it; otherwise fall back to the
 * same textual test the transcript rows use, because most runtimes don't set it.
 */
function isFailure(m: ParsedMessage): boolean {
  if (typeof m.isError === 'boolean') return m.isError;
  const s = str(m.content).slice(0, 200);
  return /\b(error|failed|failure|not permitted|denied|refused|exception|traceback|enoent)\b/i.test(
    s,
  );
}

/** Apply a filter, keeping each survivor's original position. */
export function selectTurns(
  messages: readonly ParsedMessage[] | null,
  filter: TurnFilter = {},
): IndexedTurn[] {
  if (!Array.isArray(messages)) return [];

  const types = filter.types?.length ? new Set(filter.types.map((t) => str(t))) : null;
  const agentId = filter.agentId ? str(filter.agentId) : '';
  const tool = filter.toolName ? str(filter.toolName).toLowerCase() : '';
  const search = filter.search ? str(filter.search).toLowerCase() : '';

  const out: IndexedTurn[] = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (!msg) continue;
    if (types && !types.has(str(msg.type))) continue;
    if (agentId && msg.agentId !== agentId) continue;
    if (tool && !str(msg.toolName).toLowerCase().includes(tool)) continue;
    if (filter.blobsOnly && !msg.contentRef) continue;
    if (filter.errorsOnly && !isFailure(msg)) continue;
    if (search && !haystack(msg).includes(search)) continue;
    out.push({ index, msg });
  }
  return out;
}

/**
 * One entry, rendered for an agent under a per-entry character budget.
 *
 * `content` and `toolInput` are the only unbounded fields, so they are the only
 * ones clipped; everything else is a label. A clipped entry says so, and a
 * blob-backed one carries its `sha256` rather than its bytes — that is the
 * handle `readBlob` takes.
 */
export function compactTurn(entry: IndexedTurn, maxChars = 600): Record<string, unknown> {
  const { index, msg } = entry;
  const out: Record<string, unknown> = { index, type: msg.type, timestamp: msg.timestamp };

  if (msg.agentId) out.agentId = msg.agentId;
  if (msg.source) out.source = msg.source;
  if (msg.toolName) out.toolName = msg.toolName;
  if (msg.toolUseId) out.toolUseId = msg.toolUseId;
  if (typeof msg.durationMs === 'number') out.durationMs = msg.durationMs;
  if (isFailure(msg)) out.isError = true;

  let truncated = false;

  if (msg.toolInput != null) {
    const { text, truncated: cut } = clip(msg.toolInput, maxChars);
    out.toolInput = text;
    truncated ||= cut;
  }
  // Round-tripped, not referenced: `messages` lives behind a Solid store proxy and
  // structured clone does not run proxy traps, so handing the sub-object straight back
  // fails the postMessage hop out of the iframe. See AGENTS.md "Protocol state getters".
  if (msg.action != null) out.action = JSON.parse(str(msg.action) || 'null');
  if (msg.interaction) out.interaction = clip(msg.interaction, maxChars).text;

  if (msg.contentRef) {
    // The bytes stayed on disk. Hand back the address and the preview the log
    // already carries, so deciding whether to fetch costs nothing.
    out.blob = {
      sha256: msg.contentRef.sha256,
      bytes: msg.contentRef.bytes,
      ...(msg.contentRef.mimeType ? { mimeType: msg.contentRef.mimeType } : {}),
      ...(msg.contentRef.preview ? { preview: msg.contentRef.preview } : {}),
    };
  } else if (msg.content != null) {
    const { text, truncated: cut } = clip(msg.content, maxChars);
    out.content = text;
    truncated ||= cut;
  }

  if (truncated) out.truncated = true;
  return out;
}

/** Descending count, then name — a stable order for a histogram. */
function topEntries(counts: Map<string, number>, limit: number): { name: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * What is in this session, without any of it.
 *
 * This is what the `messages` state key answers now. It used to answer with the
 * entire array, which is the whole reason an agent could not read a session
 * without swallowing it — orientation and retrieval are different questions and
 * only the second one should cost turns.
 */
export function indexSession(messages: readonly ParsedMessage[] | null): Record<string, unknown> {
  if (!Array.isArray(messages))
    return { total: 0, note: 'No session loaded — call selectSession.' };

  const byType = new Map<string, number>();
  const byAgent = new Map<string, number>();
  const byTool = new Map<string, number>();
  let errors = 0;
  let blobCount = 0;
  let blobBytes = 0;

  for (const m of messages) {
    if (!m) continue;
    byType.set(str(m.type), (byType.get(str(m.type)) ?? 0) + 1);
    if (m.agentId) byAgent.set(m.agentId, (byAgent.get(m.agentId) ?? 0) + 1);
    if (m.toolName) byTool.set(m.toolName, (byTool.get(m.toolName) ?? 0) + 1);
    if (isFailure(m)) errors++;
    if (m.contentRef) {
      blobCount++;
      blobBytes += m.contentRef.bytes;
    }
  }

  const stamps = messages.map((m) => str(m?.timestamp)).filter(Boolean);

  return {
    total: messages.length,
    span: stamps.length ? { from: stamps[0], to: stamps[stamps.length - 1] } : null,
    byType: Object.fromEntries(byType),
    errors,
    blobs: { count: blobCount, bytes: blobBytes },
    agents: topEntries(byAgent, 12),
    tools: topEntries(byTool, 20),
    note:
      'An index, not the turns. Read turns with readTurns({ offset, limit, types, agentId, ' +
      'toolName, search, errorsOnly }) — each result carries its `index`, so readTurns({ ' +
      'offset: index - 3, limit: 7 }) reads it in context. A turn with a `blob` carries the ' +
      'bytes only as a sha256; fetch them with readBlob({ sha256 }).',
  };
}
