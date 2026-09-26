/**
 * Claude SDK message mapper.
 *
 * Converts Claude Agent SDK messages to StreamMessage format.
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { SUBAGENT_TOOL_NAME } from '@yaar/shared';
import type { StreamMessage, TokenUsage } from '../types.js';
import { consumeLastCall } from '../../mcp/tool-call-buffer.js';
import { assistantNotice, describeResultError, rateLimitNotice, systemNotice } from './errors.js';
import { toNoticeMessage } from '../notice.js';
import { formatMcpResult } from '../mcp-content.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('claude:mapper');

/** A tool_use block still streaming: input_json_delta accumulates until content_block_stop. */
interface PendingToolUse {
  toolName: string;
  toolUseId?: string;
  inputChunks: string[];
}

/**
 * One stream's in-flight tool_use blocks, keyed by content-block index.
 *
 * Held by the caller for the same reason as {@link TurnUsageTracker}: block
 * indices restart at 0 in every assistant message, so a module-level buffer let
 * two agents streaming tool calls at once overwrite each other's entries —
 * wrong tool name, merged argument JSON, or a `tool_use` that never came out.
 */
export class ToolBlockBuffer {
  readonly pending = new Map<number, PendingToolUse>();
  currentIndex = -1;
  /** tool_use_id → tool name, so the `tool_result` (a separate message) can be labelled. */
  readonly names = new Map<string, string>();
}

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

/**
 * The context window from a result's per-model usage, or undefined when none is
 * stated. The largest wins: `modelUsage` also lists the auxiliary models a turn
 * touched (a Haiku title call), and the window that bounds the conversation is the
 * main model's.
 */
function contextWindowOf(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): number | undefined {
  let largest = 0;
  for (const entry of Object.values(modelUsage ?? {})) {
    if (typeof entry?.contextWindow === 'number') largest = Math.max(largest, entry.contextWindow);
  }
  return largest > 0 ? largest : undefined;
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
 * `blocks` is the caller's per-stream tool-call buffer; omit it and tool calls
 * are not assembled from stream events.
 */
export function mapClaudeMessage(
  msg: SDKMessage,
  turn?: TurnUsageTracker,
  blocks?: ToolBlockBuffer,
): StreamMessage | null {
  // Log important message types (skip noisy stream_event)
  const msgType = (msg as { type: string; subtype?: string }).type;
  const msgSubtype = (msg as { subtype?: string }).subtype;
  if (msgType !== 'stream_event' && msgSubtype !== 'thinking_tokens') {
    const subtypeStr = msgSubtype ? `, subtype=${msgSubtype}` : '';
    log.debug('sdk message', { type: `${msgType}${subtypeStr}` });
  }

  // SDK message types: system, assistant, user, result, stream_event.
  // Session ids are not mapped here: nearly every frame carries one, and the
  // provider reports it once per turn as a `session` message (`session-provider.ts`).
  if (msg.type === 'system' && msg.subtype === 'init') {
    return null;
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

  // Every remaining `system` subtype that says something went wrong. Placed after
  // the `init`/`task_*` branches above, which claim their subtypes and return.
  const sysNotice = systemNotice(msg);
  if (sysNotice) return toNoticeMessage(sysNotice);

  if (msg.type === 'assistant') {
    // An assistant frame can carry a typed failure (`error`) or an interrupt-
    // truncation flag (`aborted`). Both are notices, never `error`: the SDK
    // retries the transient codes on its own, so latching the turn closed here
    // would end it in the UI while the CLI went on to answer. When the failure
    // really is fatal, the `result` terminal below says so.
    const notice = assistantNotice(msg);
    if (notice) return toNoticeMessage(notice);
    // Don't return content here - it was already streamed via stream_event.
    return null;
  }

  if (msg.type === 'stream_event') {
    return mapStreamEvent(msg.event, turn, blocks);
  }

  if (msg.type === 'result') {
    // SDK result can be success or error - check for error subtypes
    const result = msg as {
      type: 'result';
      subtype?: string;
      is_error?: boolean;
      errors?: string[];
      terminal_reason?: string;
      stop_reason?: string | null;
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
    const window = contextWindowOf(resultMsg.modelUsage);
    const accounting = {
      ...(usage
        ? { usage, usageScope: 'turn' as const, ...cost }
        : Object.keys(cost).length
          ? { usage: { ...ZERO_USAGE }, usageScope: 'turn' as const, ...cost }
          : {}),
      ...(window ? { contextWindow: window } : {}),
    };

    if (result.is_error || result.subtype?.startsWith('error')) {
      // `errors[]` is routinely empty, which is how every failed turn used to
      // read "Unknown SDK error" regardless of cause. `describeResultError`
      // assembles the message out of `terminal_reason` and `stop_reason` too.
      const { text, code } = describeResultError(result);
      log.error('SDK error', { error: text, subtype: result.subtype });
      return {
        type: 'error',
        error: text,
        errorCode: code,
        ...accounting,
      };
    }

    return { type: 'complete', ...accounting };
  }

  if (msg.type === 'user') {
    return extractToolResult(msg.message, blocks);
  }

  // Subscription-level rate limiting — its own top-level message type, not a
  // `system` subtype, and only forwarded when the limit actually rejected a call.
  const rateNotice = rateLimitNotice(msg);
  if (rateNotice) return toNoticeMessage(rateNotice);

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

function mapStreamEvent(
  event: unknown,
  turn?: TurnUsageTracker,
  blocks?: ToolBlockBuffer,
): StreamMessage | null {
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
    if (blocks && block?.type === 'tool_use' && block.name) {
      if (block.id) blocks.names.set(block.id, block.name);
      const idx = evt.index ?? ++blocks.currentIndex;
      blocks.currentIndex = idx;
      // Still buffered — the authoritative `tool_use` with parsed input waits for
      // content_block_stop. But the *name* is known right now, and withholding it
      // until the arguments finish is what made a large tool call look like a
      // hang. Announce it; the input follows as deltas.
      blocks.pending.set(idx, {
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
    if (blocks && delta.type === 'input_json_delta' && delta.partial_json) {
      const idx = evt.index ?? blocks.currentIndex;
      const pending = blocks.pending.get(idx);
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

  if (blocks && evt.type === 'content_block_stop') {
    const idx = evt.index ?? blocks.currentIndex;
    const pending = blocks.pending.get(idx);
    if (pending) {
      blocks.pending.delete(idx);
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

  return null;
}

/**
 * Extract tool result from a user message.
 * User messages in Claude's conversation format contain tool_result blocks.
 */
function extractToolResult(message: unknown, blocks?: ToolBlockBuffer): StreamMessage | null {
  if (!message || typeof message !== 'object') return null;

  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (!Array.isArray(content)) return null;

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
        is_error?: boolean;
      };

      const resultText = formatMcpResult({
        content: toolResult.content,
        isError: toolResult.is_error,
      });

      // Emitted whether or not the blocks yielded readable text. This used to be
      // guarded on `resultText`, so an image-only result — `previewScreenshot`,
      // every window/browser capture — produced no `tool_result` at all: no
      // TOOL_PROGRESS `complete`, so the status line stayed on `Running: …` and
      // then jumped straight to `Responding…`, never showing the pause where the
      // model is actually reading the image; no `tool` stream frame, so
      // process-explorer left the call stuck in `using-tool`; no logged result,
      // and a leaked tool-name entry.
      const toolName =
        (toolResult.tool_use_id && blocks?.names.get(toolResult.tool_use_id)) ?? 'mcp_tool';
      if (toolResult.tool_use_id) blocks?.names.delete(toolResult.tool_use_id);
      return {
        type: 'tool_result',
        toolName,
        content: resultText,
        toolUseId: toolResult.tool_use_id,
      };
    }
  }

  return null;
}
