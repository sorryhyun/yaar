import { read, withLoading, errMsg } from '@bundled/yaar';
import { state, setState } from './store';
import type { SessionSummary, SessionDetail, ParsedMessage } from './types';

export async function loadSessions(): Promise<void> {
  setState('loadError', null);
  await withLoading(
    (v: boolean) => setState('loading', v),
    async () => {
      const result = await read<{ currentSessionId?: string; sessions: SessionSummary[] }>(
        'yaar://history/',
      );
      const arr = Array.isArray(result?.sessions) ? result.sessions : [];
      if (result?.currentSessionId) setState('currentSessionId', result.currentSessionId);
      // Sort newest first
      arr.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      setState('sessions', arr);
      setState('totalCount', arr.length);
    },
    (msg) => {
      console.error('Failed to load sessions', msg);
      setState('loadError', msg);
    },
  );
}

export async function loadDetail(sessionId: string): Promise<void> {
  setState('selectedId', sessionId);
  setState('detail', null);
  setState('transcript', null);
  setState('messages', null);
  setState('messagesError', null);
  setState('detailLoading', true);
  try {
    const d = await read<SessionDetail>(`yaar://history/${sessionId}`);
    if (!d.sessionId) (d as Record<string, unknown>).sessionId = sessionId;
    setState('detail', d);
  } catch (e) {
    console.error('Failed to load detail', e);
    // Fallback: use summary data from the list
    const s = state.sessions.find((s) => s.sessionId === sessionId);
    if (s) setState('detail', s as unknown as SessionDetail);
  } finally {
    setState('detailLoading', false);
  }
  // Load transcript and messages in background for agent access
  loadTranscript(sessionId);
  loadMessages(sessionId);
}

export async function loadTranscript(sessionId: string): Promise<void> {
  try {
    const data = await read<string>(`yaar://history/${sessionId}/transcript`);
    if (state.selectedId === sessionId) {
      setState('transcript', typeof data === 'string' ? data : String(data));
    }
  } catch (e) {
    console.error('Failed to load transcript', e);
  }
}

// ── Message normalisation ────────────────────────────────
//
// `yaar://history/{id}/messages` is a trust boundary: the entries are
// heterogeneous (tool_use / tool_result / thinking / action / interaction),
// they are produced by several different agent runtimes, and a single odd one
// used to take down the whole transcript. See AGENTS.md "The transcript render
// must not be able to throw".
//
// Two rules here:
//   1. Never throw. A shape we do not recognise degrades to [], never an
//      exception — because this runs inside setState, whose effects are
//      synchronous, so a throw here surfaces as a *render* failure.
//   2. Coerce rather than reject. Dropping 6874 real entries because two of
//      them carry block-form content would be worse than showing them.

function jsonish(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Coerce any content-ish value to display text.
 *
 * `content` is documented as a string but arrives as block form
 * (`[{ type: 'text', text: '…' }]`) or a bare object from some runtimes. The
 * renderer calls `.split`/`.slice` on it, so anything non-string that reaches
 * the row builders is a TypeError — which is exactly the regression this fixes.
 */
function asText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((b) => {
      if (typeof b === 'string') return b;
      const rec = b as Record<string, unknown> | null;
      if (rec && typeof rec === 'object' && typeof rec.text === 'string') return rec.text;
      return jsonish(b);
    });
    const joined = parts.filter((s) => s).join('\n');
    return joined || undefined;
  }
  return jsonish(v);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** One raw entry → a ParsedMessage whose string fields really are strings. */
function toMessage(raw: unknown): ParsedMessage {
  const e = asRecord(raw) ?? {};
  return {
    type: (typeof e.type === 'string' && e.type ? e.type : 'assistant') as ParsedMessage['type'],
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
    agentId: asStrOrNull(e.agentId),
    parentAgentId: asStrOrNull(e.parentAgentId),
    source: typeof e.source === 'string' ? e.source : undefined,
    content: asText(e.content),
    action: asRecord(e.action),
    toolName: typeof e.toolName === 'string' ? e.toolName : undefined,
    toolInput: e.toolInput,
    toolUseId: typeof e.toolUseId === 'string' ? e.toolUseId : undefined,
    interaction: asText(e.interaction),
  };
}

/** Best-effort JSON out of a string payload, tolerating a resource prefix. */
function parseLoose(s: string): unknown {
  const body = s.replace(/^\s*\[Resource[^\]]*\]\s*/, '');
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(body.slice(start));
  } catch {
    return null;
  }
}

/**
 * Accept every shape the resource has been observed to return: the documented
 * `{ messages: […] }` envelope, a bare array, or either of those still
 * serialised as a string. Anything else → [].
 */
export function normalizeMessages(data: unknown): ParsedMessage[] {
  let raw: unknown = typeof data === 'string' ? parseLoose(data) : data;
  const env = asRecord(raw);
  if (env) raw = env.messages ?? env.turns ?? env.entries;
  if (!Array.isArray(raw)) return [];
  return raw.map(toMessage);
}

export async function loadMessages(sessionId: string): Promise<void> {
  try {
    const data = await read<unknown>(`yaar://history/${sessionId}/messages`);
    const messages = normalizeMessages(data);
    if (state.selectedId !== sessionId) return;
    setState('messages', messages);
    // An empty result after a successful read is worth saying out loud: the old
    // code fell straight back to the raw markdown dump, which looked like a
    // rendering bug rather than "there was nothing to render".
    setState('messagesError', messages.length ? null : 'No structured turns in this session.');
  } catch (e) {
    const msg = errMsg(e);
    console.error('Failed to load messages', msg);
    if (state.selectedId !== sessionId) return;
    setState('messages', null);
    setState('messagesError', msg);
  }
}
