/**
 * Claude SDK message mapper.
 *
 * Converts Claude Agent SDK messages to StreamMessage format.
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { SUBAGENT_TOOL_NAME } from '@yaar/shared';
import type { StreamMessage, TokenUsage } from '../types.js';
import { consumeLastCall } from '../../mcp/tool-call-buffer.js';

/** Track tool_use_id → toolName from content_block_start events */
const toolNameById = new Map<string, string>();

/** Buffer pending tool_use blocks: accumulate input_json_delta, emit at content_block_stop */
interface PendingToolUse {
  toolName: string;
  toolUseId?: string;
  inputChunks: string[];
}
const pendingToolUse = new Map<number, PendingToolUse>();
let currentBlockIndex = -1;

/** The wire shape of an Anthropic usage block, as it appears on every carrier below. */
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Normalize one wire usage block.
 *
 * No subtraction here, unlike Codex: the Anthropic API defines `input_tokens` as
 * the input that was *neither* read from the cache nor used to create one, and
 * reports those two separately. So the field already means what `TokenUsage`
 * means by fresh input, and adding the cache counts back in would double-count.
 * Under Claude Code's caching that leaves `inputTokens` at a near-constant ~10
 * while `cacheReadTokens` carries the context — a consumer that wants "how much
 * input did this turn read" must sum all three, which is what Process Explorer
 * now does.
 */
function mapUsage(u: RawUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Turns one turn's usage reports into a stream of *deltas*.
 *
 * Claude hangs its authoritative figure on the `result` message, which arrives
 * when the turn is already over — so an agent's token column stayed blank for
 * exactly as long as it was busy, and on a first turn showed nothing at all.
 * The numbers are in fact known throughout: every `message_start` carries the
 * whole input side of an assistant message, and its `message_delta` carries the
 * final output. This folds those into a running total and reports what changed,
 * so the counter moves live and still lands on the `result` figure.
 *
 * Deltas rather than totals because {@link AgentSession} accumulates across
 * turns and cannot tell a re-report from new spend. A turn holds many assistant
 * messages (one per tool round-trip), each of which *supersedes* its own earlier
 * figure while *adding* to its predecessors' — hence the settled/in-flight split.
 *
 * One tracker is one turn, so nothing has to be reset. It is passed in rather
 * than held at module scope: agents run concurrently through this same function,
 * and a shared accumulator would credit one agent's tokens to another.
 */
export class TurnUsageTracker {
  /** Assistant messages already finished this turn — their figures are final. */
  private settled: TokenUsage = ZERO_USAGE;
  /** The in-flight assistant message's own figure, superseded as it grows. */
  private inFlight: TokenUsage = ZERO_USAGE;
  /** What has already been reported, so the next report is only what is new. */
  private emitted: TokenUsage = ZERO_USAGE;

  /** A new assistant message began — the previous one's figure is now settled. */
  begin(usage: TokenUsage): void {
    this.settled = addUsage(this.settled, this.inFlight);
    this.inFlight = usage;
  }

  /** The in-flight assistant message reported again (output grew). */
  update(usage: TokenUsage): void {
    this.inFlight = usage;
  }

  /** The turn ended; `total` is the provider's authoritative figure for it. */
  settle(total: TokenUsage): void {
    this.settled = total;
    this.inFlight = ZERO_USAGE;
  }

  /**
   * What has been spent since the last call, or `undefined` if nothing moved.
   *
   * Clamped at zero per field: a mid-turn sum can momentarily exceed the
   * `result` figure (a sub-agent's messages stream through here but may not be
   * in the parent's total), and a negative delta would credit tokens back.
   */
  take(): TokenUsage | undefined {
    const running = addUsage(this.settled, this.inFlight);
    const next: TokenUsage = {
      inputTokens: Math.max(this.emitted.inputTokens, running.inputTokens),
      outputTokens: Math.max(this.emitted.outputTokens, running.outputTokens),
      cacheReadTokens: Math.max(this.emitted.cacheReadTokens, running.cacheReadTokens),
      cacheWriteTokens: Math.max(this.emitted.cacheWriteTokens, running.cacheWriteTokens),
    };
    const delta: TokenUsage = {
      inputTokens: next.inputTokens - this.emitted.inputTokens,
      outputTokens: next.outputTokens - this.emitted.outputTokens,
      cacheReadTokens: next.cacheReadTokens - this.emitted.cacheReadTokens,
      cacheWriteTokens: next.cacheWriteTokens - this.emitted.cacheWriteTokens,
    };
    this.emitted = next;
    if (
      delta.inputTokens === 0 &&
      delta.outputTokens === 0 &&
      delta.cacheReadTokens === 0 &&
      delta.cacheWriteTokens === 0
    )
      return undefined;
    return delta;
  }
}

/**
 * Map a Claude SDK message to a StreamMessage.
 * Returns null for messages that should be skipped.
 *
 * `turn` is the caller's per-turn usage accumulator; omit it and the mid-turn
 * token reports are simply not produced (the `result` figure still is).
 */
export function mapClaudeMessage(msg: SDKMessage, turn?: TurnUsageTracker): StreamMessage | null {
  // Log important message types (skip noisy stream_event)
  const msgType = (msg as { type: string; subtype?: string }).type;
  const msgSubtype = (msg as { subtype?: string }).subtype;
  if (msgType !== 'stream_event' && msgSubtype !== 'thinking_tokens') {
    const subtypeStr = msgSubtype ? `, subtype=${msgSubtype}` : '';
    console.log(`[message-mapper] ${msgType}${subtypeStr}`);
  }

  // SDK message types: system, assistant, user, result, stream_event
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { type: 'text', sessionId: msg.session_id };
  }

  // Subagent lifecycle events
  if (msg.type === 'system' && msg.subtype === 'task_started') {
    const m = msg as { task_id?: string; description?: string };
    return {
      type: 'tool_use',
      toolName: SUBAGENT_TOOL_NAME,
      toolUseId: m.task_id,
      toolInput: { description: m.description },
    };
  }
  if (msg.type === 'system' && msg.subtype === 'task_progress') {
    const m = msg as { task_id?: string; last_tool_name?: string; description?: string };
    if (m.last_tool_name) {
      // Try to enrich with actual tool call details from the MCP buffer
      const verb = m.last_tool_name.replace(/^mcp__\w+__/, '');
      const callDetails = consumeLastCall(verb);
      const toolInput: Record<string, unknown> = { description: m.description };
      if (callDetails) {
        toolInput.uri = callDetails.uri;
        if (callDetails.payload) toolInput.payload = callDetails.payload;
      }
      return {
        type: 'tool_use',
        toolName: `${SUBAGENT_TOOL_NAME}:${m.last_tool_name}`,
        toolUseId: m.task_id,
        toolInput,
      };
    }
    if (m.description) {
      return {
        type: 'tool_use',
        toolName: SUBAGENT_TOOL_NAME,
        toolUseId: m.task_id,
        toolInput: { description: m.description },
      };
    }
    return null;
  }
  if (msg.type === 'system' && msg.subtype === 'task_notification') {
    const m = msg as { task_id?: string; summary?: string };
    return {
      type: 'tool_result',
      toolName: SUBAGENT_TOOL_NAME,
      toolUseId: m.task_id,
      content: m.summary ?? 'Task completed',
    };
  }

  if (msg.type === 'assistant') {
    // Don't return content here - it was already streamed via stream_event.
    // Only return sessionId for session tracking.
    return { type: 'text', sessionId: msg.session_id };
  }

  if (msg.type === 'stream_event') {
    return mapStreamEvent(msg.event, turn);
  }

  if (msg.type === 'result') {
    // SDK result can be success or error - check for error subtypes
    const result = msg as {
      type: 'result';
      subtype?: string;
      is_error?: boolean;
      errors?: string[];
      session_id: string;
    };

    // A failed turn still burned tokens, so usage rides the error terminal too —
    // dropping it there is how a budget readout quietly under-reports. What rides
    // is the *remainder* the mid-turn reports have not already claimed, which on a
    // turn that streamed normally is nothing at all.
    const resultMsg = msg as SDKResultMessage;
    const total = mapUsage(resultMsg.usage);
    let usage: TokenUsage | undefined;
    if (turn) {
      if (total) turn.settle(total);
      usage = turn.take();
    } else {
      usage = total;
    }
    // `total_cost_usd` is the *session's* running cost, not this turn's — measured:
    // three one-word turns reported 0.0084 → 0.0109 → 0.0137. It therefore cannot
    // ride the turn-scoped token delta, which is summed; `AgentSession.recordUsage`
    // rebases it instead. Carried on its own field so the two cannot be confused.
    const cost =
      typeof resultMsg.total_cost_usd === 'number'
        ? { sessionCostUsd: resultMsg.total_cost_usd }
        : {};
    const accounting = usage
      ? { usage, usageScope: 'turn' as const, ...cost }
      : Object.keys(cost).length
        ? { usage: { ...ZERO_USAGE }, usageScope: 'turn' as const, ...cost }
        : {};

    // Check for errors (SDKResultError type)
    if (result.is_error || result.subtype?.startsWith('error')) {
      const errorMessage = result.errors?.join('; ') || 'Unknown SDK error';
      console.error(`[message-mapper] SDK error: ${errorMessage} (subtype: ${result.subtype})`);
      return { type: 'error', error: errorMessage, sessionId: result.session_id, ...accounting };
    }

    return { type: 'complete', sessionId: result.session_id, ...accounting };
  }

  // Handle user messages containing tool results
  if (msg.type === 'user') {
    return extractToolResult(msg.message);
  }

  // Skip other types
  return null;
}

/**
 * Scan raw argument JSON for backslash-u spellings, before JSON.parse erases
 * the distinction. Backslash-run parity decides which side each hit is on:
 * an odd run ends in a live escape (`안` — the model chose the escape
 * spelling for a character; parse normalizes it), an even run puts literal
 * `\uXXXX` text into the parsed value (`\\uc548` — the double-escape form
 * that corrupts payloads). Escapes for control characters (< 0x20) are the
 * only ones JSON requires, so they don't count as a spelling choice.
 */
function countEscapeSpellings(rawJson: string): StreamMessage['toolInputEscapes'] {
  let unicodeEscapes = 0;
  let literalBackslashU = 0;
  const re = /(\\+)u([0-9a-fA-F]{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawJson)) !== null) {
    if (m[1].length % 2 === 1) {
      if (parseInt(m[2], 16) >= 0x20) unicodeEscapes++;
    } else {
      literalBackslashU++;
    }
  }
  if (unicodeEscapes === 0 && literalBackslashU === 0) return undefined;
  return { unicodeEscapes, literalBackslashU };
}

/**
 * Map a stream event to a StreamMessage.
 */
function mapStreamEvent(event: unknown, turn?: TurnUsageTracker): StreamMessage | null {
  if (!event || typeof event !== 'object') return null;

  const evt = event as {
    type: string;
    index?: number;
    delta?: unknown;
    content_block?: unknown;
    message?: { usage?: RawUsage };
    usage?: RawUsage;
  };

  // The turn's token counter, live. `message_start` carries the whole input side
  // of an assistant message (fresh, cache-read and cache-write alike) before a
  // single token is generated; `message_delta` carries that message's final
  // output. Both are per-message figures the tracker folds into a turn total —
  // see {@link TurnUsageTracker} for why this is reported as a delta.
  if (turn && (evt.type === 'message_start' || evt.type === 'message_delta')) {
    const usage = mapUsage(evt.type === 'message_start' ? evt.message?.usage : evt.usage);
    if (usage) {
      if (evt.type === 'message_start') turn.begin(usage);
      else turn.update(usage);
      const delta = turn.take();
      if (delta) return { type: 'usage', usage: delta, usageScope: 'turn' };
    }
    return null;
  }

  if (evt.type === 'content_block_start') {
    const block = evt.content_block as { type: string; name?: string; id?: string } | undefined;
    if (block?.type === 'tool_use' && block.name) {
      if (block.id) toolNameById.set(block.id, block.name);
      const idx = evt.index ?? ++currentBlockIndex;
      currentBlockIndex = idx;
      // Still buffered — the authoritative `tool_use` with parsed input waits for
      // content_block_stop. But the *name* is known right now, and withholding it
      // until the arguments finish is what made a large tool call look like a
      // hang. Announce it; the input follows as deltas.
      pendingToolUse.set(idx, {
        toolName: block.name,
        toolUseId: block.id,
        inputChunks: [],
      });
      return { type: 'tool_use_start', toolName: block.name, toolUseId: block.id };
    }
  }

  if (evt.type === 'content_block_delta') {
    const delta = evt.delta as
      | {
          type: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        }
      | undefined;
    if (!delta) return null;

    if (delta.type === 'text_delta' && delta.text) {
      return { type: 'text', content: delta.text };
    }
    if (delta.type === 'thinking_delta' && delta.thinking) {
      return { type: 'thinking', content: delta.thinking };
    }
    if (delta.type === 'input_json_delta' && delta.partial_json) {
      const idx = evt.index ?? currentBlockIndex;
      const pending = pendingToolUse.get(idx);
      if (!pending) return null;
      // Keep buffering — this fragment is still needed to assemble the real input
      // at content_block_stop. Forwarding a *copy* of it only adds a display feed;
      // it does not make the fragment authoritative. Deliberately not parsed here:
      // a prefix of a JSON document is not a JSON document.
      pending.inputChunks.push(delta.partial_json);
      return {
        type: 'tool_input_delta',
        toolName: pending.toolName,
        toolUseId: pending.toolUseId,
        content: delta.partial_json,
      };
    }
  }

  if (evt.type === 'content_block_stop') {
    const idx = evt.index ?? currentBlockIndex;
    const pending = pendingToolUse.get(idx);
    if (pending) {
      pendingToolUse.delete(idx);
      let toolInput: Record<string, unknown> | undefined;
      let toolInputEscapes: StreamMessage['toolInputEscapes'];
      if (pending.inputChunks.length > 0) {
        const rawJson = pending.inputChunks.join('');
        toolInputEscapes = countEscapeSpellings(rawJson);
        try {
          toolInput = JSON.parse(rawJson);
        } catch {
          // Malformed JSON — emit without input
        }
      }
      return {
        type: 'tool_use',
        toolName: pending.toolName,
        toolUseId: pending.toolUseId,
        toolInput,
        ...(toolInputEscapes ? { toolInputEscapes } : {}),
      };
    }
  }

  // Skip other stream events
  return null;
}

/**
 * Extract tool result from a user message.
 * User messages in Claude's conversation format contain tool_result blocks.
 */
function extractToolResult(message: unknown): StreamMessage | null {
  if (!message || typeof message !== 'object') return null;

  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (!Array.isArray(content)) return null;

  // Look for tool_result blocks
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'tool_result'
    ) {
      const toolResult = block as {
        type: string;
        tool_use_id?: string;
        content?: unknown;
      };

      // Extract the text content from the tool result
      let resultText = '';
      if (typeof toolResult.content === 'string') {
        resultText = toolResult.content;
      } else if (Array.isArray(toolResult.content)) {
        resultText = toolResult.content
          .filter(
            (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
          )
          .map((item) => {
            if (item.type === 'text' && typeof item.text === 'string') return item.text;
            if (
              item.type === 'resource' &&
              typeof item.resource === 'object' &&
              item.resource !== null
            ) {
              const res = item.resource as { text?: string; uri?: string };
              return res.text ?? `[resource: ${res.uri}]`;
            }
            if (item.type === 'resource_link') {
              const link = item as { uri?: string; name?: string };
              return `[${link.name ?? 'link'}](${link.uri})`;
            }
            return '';
          })
          .filter(Boolean)
          .join('');
      }

      if (resultText) {
        // Look up tool name from prior content_block_start event
        const toolName =
          (toolResult.tool_use_id && toolNameById.get(toolResult.tool_use_id)) ?? 'mcp_tool';
        if (toolResult.tool_use_id) toolNameById.delete(toolResult.tool_use_id);
        return {
          type: 'tool_result',
          toolName,
          content: resultText,
          toolUseId: toolResult.tool_use_id,
        };
      }
    }
  }

  return null;
}
