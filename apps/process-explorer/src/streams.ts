export {};

// Live per-agent activity: one stream subscription per agent, folded frame by
// frame into the activity store. Reconciled against the roster, so an agent that
// appears gets a stream and one that disappears has it torn down.

import { stream, type StreamFrame } from '@bundled/yaar';
import { AGENT_TIER, STREAM_KINDS, TEXT_TAIL_CHARS, agentStreamUri } from './constants';
import { clearActivity, setAgentActivity } from './store';
import type { AgentEntry, AgentFrameData } from './types';

/** Active stream unsubscribers, keyed by agent id. */
const streamStops = new Map<string, () => void>();

/**
 * Fold one frame from agent `id`'s stream into its live activity.
 *
 * `start` *replaces* the record rather than merging into it — that is the whole
 * point of the boundary. Every other kind merges, and every kind refreshes
 * `updatedAt` so a row can show how long it has been since the agent last said
 * anything.
 */
function onAgentFrame(id: string, frame: StreamFrame) {
  // The one cast at this boundary; see {@link AgentFrameData} for why it is not
  // a Zod parse. Every field read below is defaulted.
  const data = (frame.data ?? {}) as AgentFrameData;
  const at = frame.ts;

  switch (frame.kind) {
    case 'start':
      // A new turn: drop last turn's text tail and tool line entirely — but not
      // the token total, which is the agent's lifetime figure and not the turn's.
      // Clearing it would blank the column at every turn start and refill it only
      // when the provider next reports (turn's end, on Claude).
      setAgentActivity(id, (prev) => ({
        state: 'responding',
        usage: prev?.usage,
        updatedAt: at,
      }));
      break;
    case 'tool':
      setAgentActivity(id, (prev) => ({
        ...prev,
        // A finished tool hands the turn back to the model; only a running one
        // is 'using-tool'.
        state: data.status === 'running' ? 'using-tool' : 'responding',
        tool: { name: data.toolName ?? 'tool', status: data.status ?? 'running' },
        updatedAt: at,
      }));
      break;
    case 'text':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'responding',
        text: ((prev?.text ?? '') + (data.delta ?? '')).slice(-TEXT_TAIL_CHARS),
        updatedAt: at,
      }));
      break;
    case 'usage':
      // The frame's totals are cumulative for the agent, so this assigns rather
      // than adds — and it deliberately does *not* touch `state`. Both providers
      // now report usage several times mid-turn; letting that move the state
      // would make a finished turn look like it resumed.
      setAgentActivity(id, (prev) => ({
        ...prev,
        usage: {
          inputTokens: data.inputTokens ?? prev?.usage?.inputTokens ?? 0,
          outputTokens: data.outputTokens ?? prev?.usage?.outputTokens ?? 0,
          cacheReadTokens: data.cacheReadTokens ?? prev?.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: data.cacheWriteTokens ?? prev?.usage?.cacheWriteTokens ?? 0,
        },
        updatedAt: at,
      }));
      break;
    case 'done':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'done',
        endStatus: data.status === 'interrupted' ? 'interrupted' : 'completed',
        updatedAt: at,
      }));
      break;
    case 'error':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'error',
        error: data.error ?? 'error',
        updatedAt: at,
      }));
      break;
  }
}

/**
 * Reconcile the set of live streams against the current roster. Subscribes to any
 * non-session agent we aren't already watching, and drops streams for agents that
 * are gone. The session agent's stream is shielded server-side (it would 403), so
 * we never ask for it.
 */
export function reconcileStreams(agents: AgentEntry[]) {
  const live = new Set<string>();
  for (const agent of agents) {
    if (agent.type === AGENT_TIER.session) continue;
    live.add(agent.id);
    if (streamStops.has(agent.id)) continue;

    // Reserve the slot synchronously so a second reconcile before the async
    // subscribe resolves doesn't open a duplicate.
    streamStops.set(agent.id, () => {});
    stream(agentStreamUri(agent.id), (frame) => onAgentFrame(agent.id, frame), {
      kinds: [...STREAM_KINDS],
    })
      .then((stop) => {
        // Torn down (agent vanished) before the subscription landed — drop it.
        if (streamStops.has(agent.id)) streamStops.set(agent.id, stop);
        else stop();
      })
      .catch(() => {
        streamStops.delete(agent.id);
      });
  }

  for (const [id, stop] of streamStops) {
    if (live.has(id)) continue;
    stop();
    streamStops.delete(id);
    clearActivity(id);
  }
}

/** Tear down every open stream. Called on unmount. */
export function stopAllStreams() {
  for (const stop of streamStops.values()) stop();
  streamStops.clear();
}
