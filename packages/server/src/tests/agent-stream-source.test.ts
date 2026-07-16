/**
 * The agent stream *source* — StreamToEventMapper as a producer.
 *
 * Every provider `StreamMessage` the mapper turns into a frontend CLI event it now
 * *also* publishes onto `yaar://agents/{instanceId}/stream` for stream subscribers.
 * The transport-core test drives `publishFrame` directly; this one drives the real
 * mapper, so it pins the wiring the mapper owns: the URI is keyed by the agent's
 * instance id, frames are scoped to the agent's session, text arrives as a
 * coalesced delta, a tool call arrives immediately, and `complete` closes with a
 * `done`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ServerEventType, type ServerEvent, type StreamFrame } from '@yaar/shared';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

/** The two events `'verb-subscription'` carries: a stream frame, or a change ping. */
type SubscriptionEvent = Extract<
  ServerEvent,
  { type: typeof ServerEventType.STREAM_FRAME | typeof ServerEventType.VERB_SUBSCRIPTION_UPDATE }
>;

interface Captured {
  sessionId: string;
  event: SubscriptionEvent;
}

describe('agent stream source (StreamToEventMapper)', () => {
  const instanceId = 'agent-inst-9';
  const sessionId = 'ses-source-test';
  const uri = `yaar://agents/${instanceId}/stream`;
  let captured: Captured[];
  // The channel's payload is the whole `ServerEvent` union; narrow once here rather than
  // at every assertion, since these two are all the registry ever publishes on it.
  const listener = (e: SessionScopedEvent) => captured.push(e as Captured);
  const subIds: string[] = [];

  beforeEach(() => {
    captured = [];
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
      providerName: 'test-provider',
      state,
      sendEvent: async () => {}, // the untouched frontend path
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
      agentInstanceId: instanceId, // → the stream URI
      streamSessionId: sessionId, // → scope
    });
  }

  // Only STREAM_FRAME carries a frame; a change ping has no payload at all.
  const frames = (): StreamFrame[] =>
    captured
      .map((c) => (c.event.type === ServerEventType.STREAM_FRAME ? c.event.frame : undefined))
      .filter((f): f is StreamFrame => f !== undefined);
  const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

  it('publishes tool, coalesced text and done frames onto the agent stream URI', async () => {
    const subId = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream');
    subIds.push(subId);
    const mapper = makeMapper();

    await mapper.map({
      type: 'tool_use',
      toolName: 'Read',
      toolInput: { file: 'x' },
    } as StreamMessage);
    await mapper.map({ type: 'text', content: 'Hel' } as StreamMessage);
    await mapper.map({ type: 'text', content: 'lo' } as StreamMessage);
    await mapper.map({ type: 'complete' } as StreamMessage);
    await tick();

    const kinds = frames().map((f) => f.kind);
    // tool delivers immediately; `complete` is discrete too, so it flushes the
    // pending text delta *before* emitting `done` — text never trails the close.
    expect(kinds).toEqual(['tool', 'text', 'done']);
    expect(captured.every((c) => c.sessionId === sessionId)).toBe(true);
    expect(frames().every((f) => f.uri === uri)).toBe(true);

    const tool = frames().find((f) => f.kind === 'tool');
    expect(tool?.data).toMatchObject({ status: 'running' });
    const text = frames().find((f) => f.kind === 'text');
    expect(text?.data).toMatchObject({ delta: 'Hello' }); // 'Hel' + 'lo' merged
    expect(captured[0].event.type).toBe(ServerEventType.STREAM_FRAME);
  });

  it('does not publish when the agent has no instance id / session to name', async () => {
    const subId = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream');
    subIds.push(subId);
    // A mapper missing the stream id/session (e.g. an ephemeral agent) is a no-op source.
    const state = { responseText: '', thinkingText: '', currentMessageId: null };
    const mapper = new StreamToEventMapper({
      role: 'ephemeral',
      providerName: 'test-provider',
      state,
      sendEvent: async () => {},
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
    });
    await mapper.map({ type: 'text', content: 'hi' } as StreamMessage);
    await tick();
    expect(captured).toHaveLength(0);
  });
});
