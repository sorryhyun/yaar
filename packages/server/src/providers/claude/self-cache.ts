/**
 * Self cache management (`ENABLE_SELF_CACHE_MANAGEMENT=1`) — an agent dropping items
 * from its own context.
 *
 * The Agent SDK can cut a conversation's tail (`resumeSessionAt`, `forkSession`'s
 * `upToMessageId`) but not take something out of the middle, and a running CLI holds
 * its history in memory with no control request to edit it. So a removal is two steps
 * with a turn boundary between them:
 *
 * 1. **Plan** — the `remove_cache` tool, mid-turn. Reads the transcript, resolves the
 *    positions the agent named to stable keys, and queues them. Nothing changes yet.
 * 2. **Apply** — the provider, before the agent's next turn. With the process closed:
 *    fork the session, replace the queued items with markers in the fork, and open the
 *    next turn on it. The original transcript is never written to, so a fork that will
 *    not resume costs nothing — the provider falls back to the original id.
 *
 * The cost the tool description warns about is real: the edit changes the prompt from
 * the earliest removed item on, so everything after it is written to the prompt cache
 * again rather than read from it.
 */

import { existsSync } from 'fs';
import { readdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { errMessage } from '@yaar/lib/errors';
import { REMOVE_CACHE_TOOL } from '../../mcp/system/tool-names.js';
import { createLogger } from '../../observability/log.js';
import {
  listContextItems,
  parseTranscript,
  serializeTranscript,
  stubContextItems,
  type ContextItem,
} from './context-items.js';

const log = createLogger('SelfCache');

const isOwnTool = (toolName: string): boolean => toolName.endsWith(`__${REMOVE_CACHE_TOOL}`);

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

interface AgentState {
  /** The conversation this agent's turns are on, as the SDK last named it. */
  sessionId: string;
  pending: Map<string, ContextItem>;
}

const agents = new Map<string, AgentState>();

/** Record which conversation an agent is on. Called by the provider as frames name it. */
export function noteAgentSession(agentId: string, sessionId: string): void {
  const state = agents.get(agentId);
  if (!state) {
    agents.set(agentId, { sessionId, pending: new Map() });
  } else if (state.sessionId !== sessionId) {
    // Keys name items in one conversation's transcript; they mean nothing in another.
    state.sessionId = sessionId;
    state.pending.clear();
  }
}

export function forgetAgent(agentId: string): void {
  agents.delete(agentId);
}

export function hasPendingRemovals(agentId: string): boolean {
  return (agents.get(agentId)?.pending.size ?? 0) > 0;
}

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/**
 * Find a session's transcript. The CLI files it under a directory named after the
 * working directory by a rule of its own, so look for the id rather than rebuild the name.
 */
async function findTranscript(sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const root = projectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface IndexedItem {
  /** Position counting back from the call: -1 is the most recent item. */
  index: number;
  item: ContextItem;
}

export type RemovalPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Live items, newest first, not counting ones already queued. */
      items: IndexedItem[];
      /** What this call queued. */
      scheduled: IndexedItem[];
      /** Positions asked for that name nothing. */
      missing: number[];
      /** Everything queued for the next turn, this call included. */
      pendingCount: number;
    };

/**
 * Resolve positions to items and queue them for the agent's next turn. With no
 * positions, only lists what could be removed.
 */
export async function planRemoval(
  agentId: string,
  indices: number[],
  callToolUseId: string | undefined,
): Promise<RemovalPlan> {
  const state = agents.get(agentId);
  if (!state) {
    return { ok: false, reason: 'no Claude conversation is tracked for this agent' };
  }
  const path = await findTranscript(state.sessionId);
  if (!path) return { ok: false, reason: 'the conversation transcript was not found' };

  const lines = parseTranscript(await readFile(path, 'utf8'));
  const live = listContextItems(lines, { callToolUseId, isOwnTool }).filter(
    (item) => !state.pending.has(item.key),
  );
  const items = live.map((item, i) => ({ index: i - live.length, item })).reverse();

  const scheduled: IndexedItem[] = [];
  const missing: number[] = [];
  for (const index of new Set(indices)) {
    const found = items.find((entry) => entry.index === index);
    if (found) scheduled.push(found);
    else missing.push(index);
  }
  for (const { item } of scheduled) state.pending.set(item.key, item);
  if (scheduled.length > 0) {
    // The agent's own id rides every line already (the log context resolver).
    log.info('removal queued', { items: scheduled.length, pending: state.pending.size });
  }
  return { ok: true, items, scheduled, missing, pendingCount: state.pending.size };
}

/**
 * Fork `sessionId` with the agent's queued items replaced by markers, and return the
 * fork's id — or null when there was nothing to do or it could not be done, in which
 * case the caller carries on with the conversation it had. Never throws: a failed
 * removal must not cost the agent its turn. The queue is emptied either way.
 *
 * Call with the CLI process for this conversation closed; it is still appending otherwise.
 */
export async function applyPendingRemovals(
  agentId: string,
  sessionId: string,
): Promise<string | null> {
  const state = agents.get(agentId);
  if (!state || state.pending.size === 0) return null;
  const targets = [...state.pending.values()];
  state.pending.clear();

  try {
    const source = await findTranscript(sessionId);
    if (!source) return null;
    // Checked against the original first, so a queue that matches nothing never forks.
    if (stubContextItems(parseTranscript(await readFile(source, 'utf8')), targets) === 0) {
      return null;
    }

    // No `dir`: the SDK then finds the session the way `findTranscript` does, by id
    // across project directories, and writes the fork beside it.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { sessionId: forkId } = await sdk.forkSession(sessionId);
    const forkPath = await findTranscript(forkId);
    const lines = forkPath ? parseTranscript(await readFile(forkPath, 'utf8')) : [];
    const stubbed = stubContextItems(lines, targets);
    if (!forkPath || stubbed === 0) {
      await sdk.deleteSession(forkId).catch(() => {});
      log.warn('fork held none of the queued items; keeping the original');
      return null;
    }
    await writeFile(forkPath, serializeTranscript(lines));
    state.sessionId = forkId;
    log.info('removed items from context', {
      items: stubbed,
      tokens: targets.reduce((sum, item) => sum + item.tokens, 0),
    });
    return forkId;
  } catch (err) {
    log.warn('removal failed; keeping the original conversation', { err: errMessage(err) });
    return null;
  }
}
