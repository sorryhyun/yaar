export {};

// Pure display formatters. No store access, no DOM — safe to read in isolation
// and the only place the token arithmetic is spelled out.

import { formatClock } from '@bundled/yaar';
import {
  BYTES_PER_MB,
  MINUTES_PER_HOUR,
  SECONDS_PER_MINUTE,
  TOKENS_DECIMAL_BELOW,
  TOKENS_K,
  TOKENS_M,
} from './constants';
import type { AgentUsage } from './types';

/** Elapsed time since a frame arrived, as a glanceable "how stale is this row". */
export function formatAge(ts: number, at: number) {
  const secs = Math.max(0, Math.round((at - ts) / 1000));
  if (secs < 1) return 'now';
  if (secs < SECONDS_PER_MINUTE) return `${secs}s ago`;
  const mins = Math.floor(secs / SECONDS_PER_MINUTE);
  if (mins < MINUTES_PER_HOUR) return `${mins}m ago`;
  return `${Math.floor(mins / MINUTES_PER_HOUR)}h ago`;
}

/** Wall-clock time, or a placeholder before the first refresh has landed. */
export function formatTime(date: Date | null) {
  if (!date) return '--';
  return formatClock(date);
}

/** Compact token count — 812, 12.4k, 3.1M. Exact below 1k, where the digits still read. */
export function formatTokens(n: number) {
  if (n < TOKENS_K) return String(n);
  if (n < TOKENS_M) return `${(n / TOKENS_K).toFixed(n < TOKENS_DECIMAL_BELOW ? 1 : 0)}k`;
  return `${(n / TOKENS_M).toFixed(1)}M`;
}

/**
 * Input the agent actually *spent* — fresh tokens plus cache writes, cache
 * **reads excluded**. The one place those fields are summed; see {@link AgentUsage}.
 *
 * Cache reads are left out because they are the same context re-sent every turn:
 * counting them makes a long-running agent's "in" figure climb roughly linearly
 * with turn count while nothing new is being read, which reads as a leak. Cache
 * writes stay in — they are new content passing through the model for the first
 * time, and are billed as such.
 *
 * `inputTokens` alone would be too low the other way (~10 for an 18k-context
 * turn), since providers report it as the remainder that was neither read from
 * nor written to the cache. Fresh + writes is the figure that grows only when
 * the agent takes in something it has not seen before.
 */
export function inputRead(usage: AgentUsage) {
  return usage.inputTokens + (usage.cacheWriteTokens ?? 0);
}

/**
 * Token line: the total, with the input/output split behind it.
 *
 * Total first because it is the one number that answers "how much did this cost";
 * the split is what you read next when the answer is "a lot" and you want to know
 * whether it was context or generation. Empty string when nothing has been spent,
 * so a fresh agent shows no column rather than a row of zeroes.
 */
export function formatUsage(usage: AgentUsage | undefined) {
  if (!usage) return '';
  const input = inputRead(usage);
  const total = input + usage.outputTokens;
  if (total === 0) return '';
  return `${formatTokens(total)} tok · ${formatTokens(input)} in · ${formatTokens(usage.outputTokens)} out`;
}

/**
 * How long a browser session has gone untouched, in the same coarse ladder as
 * {@link formatAge} — the number matters only against the idle sweep's minutes.
 */
export function formatIdle(ms: number) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < SECONDS_PER_MINUTE) return 'active';
  const mins = Math.floor(secs / SECONDS_PER_MINUTE);
  if (mins < MINUTES_PER_HOUR) return `idle ${mins}m`;
  return `idle ${Math.floor(mins / MINUTES_PER_HOUR)}h`;
}

/** Bytes as MB — the only unit a page's JS heap is ever interestingly measured in. */
export function formatBytes(bytes: number) {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}
