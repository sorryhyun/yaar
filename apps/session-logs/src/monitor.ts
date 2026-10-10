/**
 * Which monitor a turn belongs to.
 *
 * A session can run several monitors, and the log does not say so in one place:
 * `source` is on monitor turns but missing from some assistant/tool rows, the agent id
 * encodes it in two spellings, and session meta `agents` can omit a monitor entirely
 * (it may appear only in `threadIds` and in the messages). So the resolver tries every
 * signal in a fixed order, and the session-level list unions meta with the messages.
 *
 * Pure: no DOM, no store, no verbs.
 */

import type { ParsedMessage } from './types';

export const UNKNOWN = 'unknown';

/** `yaar://monitors/1` → '1'. */
function fromSource(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^yaar:\/\/monitors\/([^/?#]+)/.exec(v);
  return m ? m[1] : null;
}

/** `monitor-1`, `monitor-1-msg-…`, `monitor-1-dm-…` → '1'. */
function fromMonitorAgent(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^monitor-(\d+)(?:-|$)/.exec(v);
  return m ? m[1] : null;
}

/** `app-devtools-m1-agent-msg-…` → '1'. */
function fromAppAgent(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /-m(\d+)-/.exec(v);
  return m ? m[1] : null;
}

function fromAgentId(v: unknown): string | null {
  return fromMonitorAgent(v) ?? fromAppAgent(v);
}

/** Window id `0/devtools` → '0'. */
function fromWindowId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\//.exec(v);
  return m ? m[1] : null;
}

/** Any label that names a monitor in one of the spellings above, or a bare number. */
function fromLabel(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  if (/^\d+$/.test(v)) return v;
  return fromSource(v) ?? fromAgentId(v) ?? fromWindowId(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Meta `agents` as `[agentId, entry]` pairs, whether it arrives as an array or a map. */
function agentEntries(agents: unknown): [string | null, Record<string, unknown>][] {
  if (Array.isArray(agents)) {
    return agents.flatMap((a) => {
      const r = asRecord(a);
      if (!r) return [];
      const id = typeof r.agentId === 'string' ? r.agentId : typeof r.id === 'string' ? r.id : null;
      return [[id, r] as [string | null, Record<string, unknown>]];
    });
  }
  const rec = asRecord(agents);
  if (!rec) return [];
  return Object.entries(rec).flatMap(([k, a]) => {
    const r = asRecord(a);
    return r
      ? [[typeof r.agentId === 'string' ? r.agentId : k, r] as [string, Record<string, unknown>]]
      : [];
  });
}

/** agentId → monitor, from each meta agent's `monitorId` (newer logs) or `windowId` prefix. */
export function metaWindowMonitors(meta: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, a] of agentEntries(asRecord(meta)?.agents)) {
    const mon = fromLabel(a.monitorId) ?? fromWindowId(a.windowId);
    if (id && mon) out.set(id, mon);
  }
  return out;
}

/**
 * One turn's monitor, in a fixed order: the row's own `monitorId` → `source` → `monitor-N`
 * agent id → `-mN-` in the agent id → parentAgentId (same two rules) → the row's
 * `windowId` prefix → meta monitor of its agent → null.
 */
export function resolveMonitor(m: ParsedMessage, windows: Map<string, string>): string | null {
  return (
    fromLabel(m.monitorId) ??
    fromSource(m.source) ??
    fromMonitorAgent(m.agentId) ??
    fromAppAgent(m.agentId) ??
    fromAgentId(m.parentAgentId) ??
    fromWindowId(m.windowId) ??
    (m.agentId ? windows.get(m.agentId) : undefined) ??
    (m.parentAgentId ? windows.get(m.parentAgentId) : undefined) ??
    null
  );
}

/**
 * Stamp `monitor` on every message. Mutates: call it on freshly parsed entries, before
 * they enter the store.
 *
 * A turn none of the rules place inherits what other turns of the same agent resolved
 * to, so an assistant row that lost its `source` still lands with its agent's monitor.
 */
export function annotateMonitors(messages: ParsedMessage[], meta: unknown): ParsedMessage[] {
  const windows = metaWindowMonitors(meta);
  const learned = new Map<string, string>();
  const pending: ParsedMessage[] = [];
  for (const m of messages) {
    const mon = resolveMonitor(m, windows);
    if (mon) {
      m.monitor = mon;
      if (m.agentId && !learned.has(m.agentId)) learned.set(m.agentId, mon);
    } else {
      pending.push(m);
    }
  }
  for (const m of pending) m.monitor = (m.agentId && learned.get(m.agentId)) || UNKNOWN;
  return messages;
}

/** Does this meta object carry anything the badge can be computed from? */
export function hasMonitorMeta(meta: unknown): boolean {
  const r = asRecord(meta);
  return !!r && (r.threadIds != null || r.agents != null);
}

/**
 * The monitors a session ran, from meta alone: `threadIds` keys plus `agents`. Cheap —
 * no messages — which is what lets every session-list row carry one.
 */
export function monitorsFromMeta(meta: unknown): string[] {
  const r = asRecord(meta);
  if (!r) return [];
  const set = new Set<string>();
  const add = (v: string | null) => v && set.add(v);
  const threads = r.threadIds;
  if (Array.isArray(threads)) threads.forEach((t) => add(fromLabel(t)));
  else Object.keys(asRecord(threads) ?? {}).forEach((k) => add(fromLabel(k)));
  for (const [id, a] of agentEntries(r.agents)) {
    add(
      fromLabel(a.monitorId) ??
        fromAgentId(id) ??
        fromWindowId(a.windowId) ??
        fromAgentId(a.parentAgentId),
    );
  }
  return sortMonitors([...set]);
}

/** Numeric order, 'unknown' last. */
export function sortMonitors(list: string[]): string[] {
  const key = (s: string) => (s === UNKNOWN ? Infinity : /^\d+$/.test(s) ? Number(s) : 1e9);
  return list.slice().sort((a, b) => key(a) - key(b) || a.localeCompare(b));
}

/**
 * A caller's monitor argument → the id turns are stamped with, or null for "all".
 * Accepts 1, '1', 'monitor-1', 'M1', 'unknown' and 'all'.
 */
export function normalizeMonitor(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'all') return null;
  const m = /^(?:monitor[-\s]?|m)?(\d+)$/.exec(s);
  if (m) return m[1];
  return fromSource(s) ?? s;
}

export function monitorLabel(id: string): string {
  return id === UNKNOWN ? 'Unknown' : `Monitor ${id}`;
}
