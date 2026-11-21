/**
 * What an agent can drop from its own context, read off a Claude CLI transcript.
 *
 * Pure: parses the JSONL the CLI writes, lists the removable items in order, and
 * swaps chosen ones for a one-line marker. The I/O (which file, when, the fork)
 * is `self-cache.ts`.
 *
 * Two kinds of item, because those are the two an edit can touch without breaking
 * the conversation:
 *
 * - a **tool result** — its body is replaced and the `tool_use` that asked for it
 *   stays, so the pairing the API requires is intact;
 * - an **assistant text block** — thinking blocks are signed and tool calls are
 *   what results hang off, so neither is offered.
 *
 * The marker is deliberate. Measured against the CLI: deleting a tool_use/tool_result
 * pair outright left the agent no trace of having read anything, and it simply made
 * the same call again — more context, not less.
 *
 * The entry shape is the CLI's own on-disk format, not SDK surface, so everything
 * here reads defensively and treats an unrecognised entry as "not an item".
 */

/** Every marker starts with this, which is also how an already-removed item is recognised. */
export const REMOVED_PREFIX = '[Removed from context by remove_cache';

/** Rough chars-per-token for the size estimate shown to the agent. */
const CHARS_PER_TOKEN = 4;
/** Flat estimate for an image block; the base64 length says nothing about its token cost. */
const IMAGE_TOKENS = 1500;
const LABEL_MAX = 80;

type Json = Record<string, unknown>;

/** One transcript line. `entry` is null when the line did not parse (kept verbatim). */
export interface TranscriptLine {
  raw: string;
  entry: Json | null;
  dirty: boolean;
}

export interface ContextItem {
  /** Survives a fork: tool_use ids and API message ids are copied, entry uuids are not. */
  key: string;
  kind: 'tool_result' | 'assistant_text';
  /** What it is, for the agent: the tool and its target, or the start of the text. */
  label: string;
  tokens: number;
}

export function parseTranscript(jsonl: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let entry: Json | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) entry = parsed;
    } catch {
      // A line still being written, or one this reader does not understand.
    }
    lines.push({ raw, entry, dirty: false });
  }
  return lines;
}

/** Untouched lines go back byte for byte; only edited ones are re-serialised. */
export function serializeTranscript(lines: TranscriptLine[]): string {
  return lines.map((l) => (l.dirty && l.entry ? JSON.stringify(l.entry) : l.raw)).join('\n') + '\n';
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blocksOf(entry: Json): Json[] {
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

function messageId(entry: Json): string | undefined {
  const message = entry.message;
  return isObject(message) && typeof message.id === 'string' ? message.id : undefined;
}

/** A main-thread conversation entry of the given role. */
function isTurnEntry(entry: Json | null, type: 'user' | 'assistant'): entry is Json {
  return entry !== null && entry.type === type && entry.isSidechain !== true;
}

function truncate(text: string, max = LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolLabel(use: Json | undefined): string {
  if (!use || typeof use.name !== 'string') return 'tool result';
  const name = use.name.replace(/^mcp__.+?__/, '');
  const input = isObject(use.input) ? use.input : {};
  const hint =
    typeof input.uri === 'string'
      ? input.uri
      : Object.values(input).find((v): v is string => typeof v === 'string');
  return hint ? `${name} ${truncate(hint, LABEL_MAX - name.length - 1)}` : name;
}

/** Size of a tool result body, and whether it is already a marker. */
function measureResult(content: unknown): { tokens: number; removed: boolean } {
  if (typeof content === 'string') {
    return {
      tokens: Math.ceil(content.length / CHARS_PER_TOKEN),
      removed: content.startsWith(REMOVED_PREFIX),
    };
  }
  if (!Array.isArray(content)) return { tokens: 0, removed: false };
  let chars = 0;
  let images = 0;
  let removed = false;
  for (const block of content.filter(isObject)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length;
      if (block.text.startsWith(REMOVED_PREFIX)) removed = true;
    } else if (block.type === 'image') {
      images++;
    } else {
      chars += JSON.stringify(block).length;
    }
  }
  return { tokens: Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS, removed };
}

/**
 * Where "now" is: the index of the first line that belongs to the assistant message
 * making the call, so that nothing in that message counts as an earlier item.
 *
 * The CLI usually has not written the calling message when its tool runs (measured:
 * everything up to the previous tool result is on disk, the message in flight is not),
 * but the write is asynchronous and can land first. So: cut at the calling message
 * when its `tool_use` is found, and otherwise drop a trailing run of assistant entries —
 * a transcript at rest never ends on one mid-turn, so a trailing run is the message in
 * flight, part-written.
 */
function currentPosition(lines: TranscriptLine[], callToolUseId: string | undefined): number {
  if (callToolUseId) {
    const caller = lines.find(
      (l) =>
        isTurnEntry(l.entry, 'assistant') &&
        blocksOf(l.entry).some((b) => b.type === 'tool_use' && b.id === callToolUseId),
    );
    const id = caller?.entry ? messageId(caller.entry) : undefined;
    if (id) {
      return lines.findIndex((l) => isTurnEntry(l.entry, 'assistant') && messageId(l.entry) === id);
    }
  }
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = lines[i].entry;
    if (isTurnEntry(entry, 'user')) break;
    if (isTurnEntry(entry, 'assistant')) end = i;
  }
  return end;
}

/** Lines before this index were summarised away by a compaction and are not in context. */
function contextStart(lines: TranscriptLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = lines[i].entry;
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') return i + 1;
  }
  return 0;
}

export interface ListOptions {
  /** The `tool_use` id of the call asking, when the client sent one. */
  callToolUseId?: string;
  /** Tools whose results are bookkeeping rather than context worth addressing. */
  isOwnTool?: (toolName: string) => boolean;
}

/**
 * The removable items before the current position, oldest first. Items that are
 * already markers are left out, so positions always count live content.
 */
export function listContextItems(lines: TranscriptLine[], opts: ListOptions = {}): ContextItem[] {
  const toolUses = new Map<string, Json>();
  for (const { entry } of lines) {
    if (!isTurnEntry(entry, 'assistant')) continue;
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') toolUses.set(block.id, block);
    }
  }

  const start = contextStart(lines);
  const end = currentPosition(lines, opts.callToolUseId);
  const textOrdinals = new Map<string, number>();
  const items: ContextItem[] = [];

  for (let i = 0; i < end; i++) {
    const entry = lines[i].entry;
    if (isTurnEntry(entry, 'user')) {
      if (i < start) continue;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const use = toolUses.get(block.tool_use_id);
        if (typeof use?.name === 'string' && opts.isOwnTool?.(use.name)) continue;
        const { tokens, removed } = measureResult(block.content);
        if (removed) continue;
        items.push({
          key: `tool:${block.tool_use_id}`,
          kind: 'tool_result',
          label: toolLabel(use),
          tokens,
        });
      }
    } else if (isTurnEntry(entry, 'assistant')) {
      const id = messageId(entry);
      if (!id) continue;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        // Counted before any filter: the ordinal is the block's identity within its message.
        const ordinal = textOrdinals.get(id) ?? 0;
        textOrdinals.set(id, ordinal + 1);
        if (i < start || !block.text.trim() || block.text.startsWith(REMOVED_PREFIX)) continue;
        items.push({
          key: `text:${id}:${ordinal}`,
          kind: 'assistant_text',
          label: `"${truncate(block.text, LABEL_MAX - 2)}"`,
          tokens: Math.ceil(block.text.length / CHARS_PER_TOKEN),
        });
      }
    }
  }
  return items;
}

function resultMarker(item: ContextItem): string {
  return `${REMOVED_PREFIX}: ${item.label}, ~${item.tokens} tokens. Make the call again if you need it.]`;
}

const TEXT_MARKER = `${REMOVED_PREFIX}.]`;

/**
 * Replace each item's content with a marker, in place. Returns how many were found —
 * items are matched by key, so this works on a fork of the transcript they were listed from.
 */
export function stubContextItems(lines: TranscriptLine[], items: ContextItem[]): number {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const textOrdinals = new Map<string, number>();
  let stubbed = 0;

  for (const line of lines) {
    const entry = line.entry;
    if (isTurnEntry(entry, 'user')) {
      let touched = false;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const item = byKey.get(`tool:${block.tool_use_id}`);
        if (!item) continue;
        block.content = [{ type: 'text', text: resultMarker(item) }];
        touched = true;
        stubbed++;
      }
      if (touched) {
        // The CLI keeps a second, structured copy of the result beside the message.
        if ('toolUseResult' in entry) entry.toolUseResult = TEXT_MARKER;
        delete entry.mcpMeta;
        line.dirty = true;
      }
    } else if (isTurnEntry(entry, 'assistant')) {
      const id = messageId(entry);
      if (!id) continue;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const ordinal = textOrdinals.get(id) ?? 0;
        textOrdinals.set(id, ordinal + 1);
        if (!byKey.has(`text:${id}:${ordinal}`)) continue;
        block.text = TEXT_MARKER;
        line.dirty = true;
        stubbed++;
      }
    }
  }
  return stubbed;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}
