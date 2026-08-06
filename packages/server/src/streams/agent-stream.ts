/**
 * The agent stream source — `yaar://agents/{instanceId}/stream`.
 *
 * A subscriber (an app via `yaar.stream()`, or later another agent) that watches
 * this URI receives the agent's live transcript as {@link StreamFrame}s: `text`
 * and `thinking` *deltas*, `tool` progress, a terminal `done`. The producer is
 * {@link StreamToEventMapper}, which already turns every provider `StreamMessage`
 * into a frontend event — it now additionally calls `streamHub.publish(...)` onto
 * this URI (see stream-to-event-mapper.ts).
 *
 * The `{instanceId}` is the agent's stable id — the same value the roster at
 * `yaar://session/agents` exposes as `AgentEntry.id`, so a consumer reading the
 * roster already holds the key it needs to subscribe.
 *
 * This is intentionally a thin pair of pure helpers rather than a full
 * URI-pattern → attach-function registry: the agent source *pushes* (the mapper
 * publishes as it runs) rather than attaching lazily on subscribe, so there is no
 * attach function to register yet. The registry earns its keep once a pull-style
 * source lands.
 */

/**
 * Frame kinds an agent stream emits. Source-defined, not a closed protocol enum.
 *
 * `start` and `done` are the *turn boundaries*, and they are deliberately not
 * derived from a provider message: Claude's `result` and Codex's `turn/completed`
 * only arrive when the turn ends *cleanly*, so an interrupted or aborted turn
 * would strand an observer mid-`responding` forever. The mapper publishes them
 * from the query loop's own lifecycle instead, which makes them identical for
 * both providers and guarantees the pair even when the provider stream doesn't.
 */
export type AgentStreamKind =
  | 'start'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'usage'
  | 'notice'
  | 'done'
  | 'error';

export type AgentTurnStatus = 'completed' | 'interrupted';

/**
 * A non-terminal provider notice — a retry, a denial, a refusal, a hit limit.
 *
 * Distinct from the `error` frame, which is terminal and pairs with `done` as a
 * turn boundary. A `notice` says nothing about whether the turn survived; an
 * observer that treats one as an ending will strand itself, and one that ignores
 * them will show a turn that sat silent for thirty seconds with no explanation.
 */
export interface AgentNoticeFrameData {
  level: 'info' | 'warning';
  text: string;
  /** The provider's own discriminant, e.g. `rate_limit`, `api_retry`. */
  code?: string;
}

export interface AgentStartFrameData {
  messageId?: string;
  provider: string;
  monitorId?: string;
}

/**
 * Token accounting for the agent, as of this frame.
 *
 * Cumulative over the agent's whole life, not the turn — a `start` frame resets
 * an observer's view of *activity*, and resetting the counter with it would make
 * the reading useless for anyone who attached mid-session. The turn's own
 * contribution rides along as `turn` for observers that want a rate.
 *
 * Emitted whenever the provider reports usage: once at the end of a turn for
 * Claude, several times within one for Codex. An observer that only wants the
 * final figure can read the roster instead — `yaar://session/agents` carries the
 * same totals per agent.
 */
export interface AgentUsageFrameData {
  inputTokens: number;
  outputTokens: number;
  /** `inputTokens + outputTokens` — cache reads and writes excluded. */
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  /** What this turn alone added, in the same units. */
  turn?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

const AGENT_STREAM_RE = /^yaar:\/\/agents\/([^/]+)\/stream$/;

export function buildAgentStreamUri(instanceId: string): string {
  return `yaar://agents/${instanceId}/stream`;
}

export function parseAgentStreamUri(uri: string): string | null {
  const m = AGENT_STREAM_RE.exec(uri);
  return m ? m[1] : null;
}
