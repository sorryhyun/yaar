import { createSignal } from '@bundled/solid-js';
import { list } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { AgentEntry, AgentRoster, AgentUsage } from './schema';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** inputTokens + cacheWriteTokens + outputTokens — cache reads excluded, as in Process Explorer. */
  total: number;
}

export interface AgentRow {
  id: string;
  type: string;
  label: string;
  busy: boolean;
  appId?: string;
  usage?: Usage;
}

export interface Roster {
  agents: AgentRow[];
  busy: number;
  /** Session lifetime total, disposed agents included — so it exceeds the sum of `agents`. */
  sessionUsage?: Usage;
  updatedAt: string;
}

export const POLL_MS = 5000;

export const [roster, setRoster] = createSignal<Roster | null>(null);
export const [rosterError, setRosterError] = createSignal<string | null>(null);

function toUsage(raw: z.infer<typeof AgentUsage> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const inputTokens = raw.inputTokens ?? 0;
  const outputTokens = raw.outputTokens ?? 0;
  const cacheReadTokens = raw.cacheReadTokens ?? 0;
  const cacheWriteTokens = raw.cacheWriteTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    total: inputTokens + cacheWriteTokens + outputTokens,
  };
}

export async function fetchRoster() {
  try {
    const parsed = z.safeParse(AgentRoster, (await list<unknown>('yaar://session/agents')) ?? {});
    if (!parsed.success) throw new Error('malformed agent roster');
    const agents: AgentRow[] = [];
    for (const entry of parsed.data.agents ?? []) {
      const row = z.safeParse(AgentEntry, entry);
      if (!row.success) continue;
      const a = row.data;
      agents.push({
        id: a.id,
        type: a.type,
        label: a.label ?? a.id,
        busy: a.busy ?? false,
        appId: a.appId,
        usage: toUsage(a.usage),
      });
    }
    setRoster({
      agents,
      busy: parsed.data.busyAgents ?? agents.filter((a) => a.busy).length,
      sessionUsage: toUsage(parsed.data.usage),
      updatedAt: new Date().toISOString(),
    });
    setRosterError(null);
  } catch (err) {
    // Dock is core chrome: keep the last good roster and surface the error in state.
    setRosterError(err instanceof Error ? err.message : String(err));
  }
}

/** Compact token count — 812, 12.4k, 3.1M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}