/**
 * The live output tail — `tool_output_delta` through StreamToEventMapper.
 *
 * A running command's stdout reaches the CLI panel as `TOOL_PROGRESS` events with
 * `status: 'output'`, appended in order. Three properties make that safe to turn on:
 *
 *   1. it is frontend-only — no stream frame, for the same reason `tool_input_delta`
 *      publishes none: a subscriber handed a half-written result will parse it;
 *   2. it is capped per call, so a command that prints without bound doesn't become
 *      unbounded WebSocket traffic;
 *   3. the cap is released when the call ends, so the next command gets a full budget
 *      rather than inheriting an exhausted one.
 *
 * The authoritative output still arrives whole on `tool_result` in every case — the
 * tail is progress, not the result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ServerEventType, type ServerEvent, type StreamFrame } from '@yaar/shared';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

/** Mirrors MAX_TOOL_OUTPUT_TAIL_BYTES in stream-to-event-mapper.ts. */
const CAP = 64 * 1024;

interface ToolProgress {
  type: typeof ServerEventType.TOOL_PROGRESS;
  toolName: string;
  status: string;
  message?: string;
}

describe('tool output tail', () => {
  const instanceId = 'agent-tail-1';
  const sessionId = 'ses-tail-test';
  let sent: ServerEvent[];
  let frames: StreamFrame[];
  const listener = (e: SessionScopedEvent) => {
    const ev = (e as { event: ServerEvent }).event;
    if (ev.type === ServerEventType.STREAM_FRAME) frames.push(ev.frame);
  };
  const subIds: string[] = [];

  beforeEach(() => {
    sent = [];
    frames = [];
    actionEmitter.on('verb-subscription', listener);
  });
  afterEach(() => {
    actionEmitter.off('verb-subscription', listener);
    for (const id of subIds.splice(0)) subscriptionRegistry.unsubscribe(id);
  });

  function makeMapper() {
    const state = { responseText: '', thinkingText: '', currentMessageId: null };
    return new StreamToEventMapper({
      role: 'monitor',
      providerName: 'codex',
      state,
      sendEvent: async (e: ServerEvent) => {
        sent.push(e);
      },
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
      agentInstanceId: instanceId,
      streamSessionId: sessionId,
    });
  }

  const outputs = (): ToolProgress[] =>
    sent.filter(
      (e): e is ServerEvent & ToolProgress =>
        e.type === ServerEventType.TOOL_PROGRESS && (e as { status?: string }).status === 'output',
    );

  const delta = (content: string, toolUseId = 'item-1'): StreamMessage =>
    ({ type: 'tool_output_delta', toolName: 'command', toolUseId, content }) as StreamMessage;

  it('forwards each chunk in order as an output-status tool progress event', async () => {
    const mapper = makeMapper();
    await mapper.map(delta('one\n'));
    await mapper.map(delta('two\n'));

    expect(outputs().map((e) => e.message)).toEqual(['one\n', 'two\n']);
    expect(outputs()[0].toolName).toBe('command');
  });

  it('drops an empty chunk instead of emitting a contentless event', async () => {
    const mapper = makeMapper();
    await mapper.map(delta(''));
    expect(outputs()).toHaveLength(0);
  });

  it('publishes no stream frame — the tail is display-only', async () => {
    const subId = subscriptionRegistry.subscribe(
      'tok',
      'win-1',
      sessionId,
      `yaar://agents/${instanceId}/stream`,
      'stream',
    );
    subIds.push(subId);
    const mapper = makeMapper();

    await mapper.map(delta('secret half-written output'));
    await new Promise((r) => setTimeout(r, 90));

    expect(frames).toHaveLength(0);
  });

  it('stops forwarding once the per-call cap is reached, trimming the crossing chunk', async () => {
    const mapper = makeMapper();
    // Two chunks that straddle the cap, then one wholly past it.
    await mapper.map(delta('x'.repeat(CAP - 10)));
    await mapper.map(delta('y'.repeat(100)));
    await mapper.map(delta('z'.repeat(100)));

    const messages = outputs().map((e) => e.message ?? '');
    expect(messages.join('').length).toBe(CAP);
    expect(messages[1]).toBe('y'.repeat(10)); // trimmed to what was left
    expect(messages.join('')).not.toContain('z'); // past the cap: silent
  });

  it('gives the next call its own budget once the previous one ends', async () => {
    const mapper = makeMapper();
    await mapper.map(delta('x'.repeat(CAP)));
    await mapper.map(delta('over'));
    expect(outputs().at(-1)?.message).toBe('x'.repeat(CAP)); // 'over' was dropped

    // The result closes the call and releases its budget.
    await mapper.map({
      type: 'tool_result',
      toolName: 'command',
      toolUseId: 'item-1',
      content: 'done',
    } as StreamMessage);

    await mapper.map(delta('fresh', 'item-2'));
    expect(outputs().at(-1)?.message).toBe('fresh');
  });
});
