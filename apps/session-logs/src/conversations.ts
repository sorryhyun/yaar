/**
 * One session log → its conversations.
 *
 * A log is one server launch, but what a person thinks of as "a session" is one
 * monitor's conversation: monitors talk independently, and a reset starts a monitor
 * over without starting a new log. The server records both — the session's monitors
 * and every reset (`{ at, monitorIds }`) in the list summary, and a `reset` entry in
 * the messages at the point it happened — so the list splits a log into a row per
 * monitor per reset, and the transcript keeps the turns of one of them.
 *
 * `epoch` is the conversation's number within its monitor: 0 until that monitor's first
 * reset, 1 after it, and so on. A turn and a row agree on it because both count the same
 * resets: the list from the summary's `resets`, the turns from the `reset` entries.
 *
 * Pure: no DOM, no store, no verbs.
 */

import type { ParsedMessage, ResetRecord, SessionSummary } from './types';
import { DEFAULT_MONITOR, UNKNOWN, sortMonitors } from './monitor';

/** The scope of a log that predates per-monitor meta: the whole log, one row. */
export const ALL = 'all';

export interface Conversation {
  /** Unique across the list: `{sessionId}|{monitor}|{epoch}`. */
  key: string;
  sessionId: string;
  /** Monitor id, or {@link ALL} for a log with no monitor list. */
  monitor: string;
  epoch: number;
  /** How many conversations this monitor has in the session. */
  count: number;
  start: string;
  end: string;
  /** The monitor's newest conversation — the one still being written, in the live log. */
  latest: boolean;
}

/** `resets` as the summary carries it, dropping anything malformed. */
export function resetsOf(s: { resets?: unknown }): ResetRecord[] {
  if (!Array.isArray(s.resets)) return [];
  return s.resets.flatMap((r) => {
    const rec = r as Partial<ResetRecord> | null;
    if (!rec || typeof rec.at !== 'string' || !Array.isArray(rec.monitorIds)) return [];
    return [{ at: rec.at, monitorIds: rec.monitorIds.map(String) }];
  });
}

/** Every conversation in one session log, oldest first within each monitor. */
export function conversationsOf(s: SessionSummary): Conversation[] {
  const start = s.createdAt ?? '';
  const end = s.lastActivity ?? start;
  const monitors = Array.isArray(s.monitors) ? sortMonitors(s.monitors.map(String)) : [];
  if (monitors.length === 0) {
    return [
      {
        key: `${s.sessionId}|${ALL}|0`,
        sessionId: s.sessionId,
        monitor: ALL,
        epoch: 0,
        count: 1,
        start,
        end,
        latest: true,
      },
    ];
  }

  const resets = resetsOf(s);
  return monitors.flatMap((monitor) => {
    const cuts = resets.filter((r) => r.monitorIds.includes(monitor)).map((r) => r.at);
    const count = cuts.length + 1;
    return Array.from({ length: count }, (_, epoch) => ({
      key: `${s.sessionId}|${monitor}|${epoch}`,
      sessionId: s.sessionId,
      monitor,
      epoch,
      count,
      start: epoch === 0 ? start : cuts[epoch - 1],
      end: epoch < cuts.length ? cuts[epoch] : end,
      latest: epoch === count - 1,
    }));
  });
}

/**
 * The monitor a turn counts toward when splitting by conversation.
 *
 * A turn nothing could place (`unknown`) goes to monitor 0 — the server makes the same
 * call for a sourceless turn when it restores, and in a log new enough to be split,
 * agent-less rows are stamped with their monitor, so these are few.
 */
export function conversationMonitor(m: ParsedMessage): string {
  return !m.monitor || m.monitor === UNKNOWN ? DEFAULT_MONITOR : m.monitor;
}

/**
 * Stamp `epoch` on every turn. Mutates: call it after `annotateMonitors`, on freshly
 * parsed entries, before they enter the store.
 */
export function annotateEpochs(messages: ParsedMessage[]): ParsedMessage[] {
  const resets = new Map<string, number>();
  for (const m of messages) {
    if (m.type === 'reset') {
      for (const id of m.monitorIds ?? []) resets.set(id, (resets.get(id) ?? 0) + 1);
      continue;
    }
    m.epoch = resets.get(conversationMonitor(m)) ?? 0;
  }
  return messages;
}

/** Conversations per monitor in a loaded session, from its turns' stamps. */
export function epochCounts(messages: readonly ParsedMessage[] | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m) continue;
    if (m.type === 'reset') {
      for (const id of m.monitorIds ?? []) out.set(id, (out.get(id) ?? 1) + 1);
      continue;
    }
    const mon = conversationMonitor(m);
    if (!out.has(mon)) out.set(mon, 1);
  }
  return out;
}
