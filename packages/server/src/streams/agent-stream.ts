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
export type AgentStreamKind = 'start' | 'text' | 'thinking' | 'tool' | 'done' | 'error';

export type AgentTurnStatus = 'completed' | 'interrupted';

export interface AgentStartFrameData {
  messageId?: string;
  provider: string;
  monitorId?: string;
}

const AGENT_STREAM_RE = /^yaar:\/\/agents\/([^/]+)\/stream$/;

export function buildAgentStreamUri(instanceId: string): string {
  return `yaar://agents/${instanceId}/stream`;
}

export function parseAgentStreamUri(uri: string): string | null {
  const m = AGENT_STREAM_RE.exec(uri);
  return m ? m[1] : null;
}
