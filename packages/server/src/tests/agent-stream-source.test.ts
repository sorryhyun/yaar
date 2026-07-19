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

  it('publishes a pending tool frame before the arguments exist, then replaces it', async () => {
    const subId = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream');
    subIds.push(subId);
    const mapper = makeMapper();

    // The Claude shape: name first, arguments as deltas, authoritative call last.
    await mapper.map({ type: 'tool_use_start', toolName: 'Write' } as StreamMessage);
    await mapper.map({
      type: 'tool_input_delta',
      toolName: 'Write',
      content: '{"path":"/tmp/a"}',
    } as StreamMessage);
    await mapper.map({
      type: 'tool_use',
      toolName: 'Write',
      toolInput: { path: '/tmp/a' },
    } as StreamMessage);
    await tick();

    const tools = frames().filter((f) => f.kind === 'tool');
    expect(tools.map((f) => (f.data as { status: string }).status)).toEqual(['pending', 'running']);
    // The pending frame names the tool with no input; the running frame carries it.
    expect(tools[0].data).toMatchObject({ toolName: 'Write', status: 'pending' });
    expect(tools[1].data).toMatchObject({ status: 'running', input: { path: '/tmp/a' } });
  });

  it('does not publish raw argument fragments to app subscribers', async () => {
    const subId = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream');
    subIds.push(subId);
    const mapper = makeMapper();

    await mapper.map({ type: 'tool_use_start', toolName: 'Write' } as StreamMessage);
    await mapper.map({
      type: 'tool_input_delta',
      toolName: 'Write',
      content: '{"body":"half-writ',
    } as StreamMessage);
    await tick();

    // Partial JSON stays on the frontend-only path: handing it to apps invites
    // parsing a prefix, and only one provider can produce it at all. Apps see
    // `pending` → `running` on `tool` frames, which degrades cleanly on Codex.
    const serialized = JSON.stringify(frames());
    expect(serialized).not.toContain('half-writ');
    expect(frames().map((f) => f.kind)).toEqual(['tool']);
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

/**
 * Turn boundaries (Phase 2.1).
 *
 * `start`/`done` are published by the *query loop*, not by a provider message, so
 * they must hold for a turn that ends any way at all: cleanly, interrupted, or
 * thrown. The tests below drive the mapper the way `AgentSession` does — `start()`
 * before consuming, provider messages, then `finish()` in the `finally` — and pin
 * that exactly one open and one close reach the observer each time.
 */
describe('agent stream turn boundaries', () => {
  const instanceId = 'agent-inst-boundary';
  const sessionId = 'ses-boundary-test';
  const uri = `yaar://agents/${instanceId}/stream`;
  let captured: Captured[];
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

  const frames = (): StreamFrame[] =>
    captured
      .map((c) => (c.event.type === ServerEventType.STREAM_FRAME ? c.event.frame : undefined))
      .filter((f): f is StreamFrame => f !== undefined);
  const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

  function makeMapper(providerName: string, messageId: string | null = 'msg-7') {
    const state = { responseText: '', thinkingText: '', currentMessageId: messageId };
    return new StreamToEventMapper({
      role: 'monitor',
      providerName,
      state,
      sendEvent: async () => {},
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
      agentInstanceId: instanceId,
      streamSessionId: sessionId,
    });
  }

  function subscribeAll(): void {
    subIds.push(subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream'));
  }

  // Both providers' *normalized* turns — this is what `AgentSession` feeds the
  // mapper after `providers/{claude,codex}/message-mapper.ts` has run. Written out
  // per provider so a divergence in normalization shows up as a boundary failure.
  const NORMALIZED_TURNS: Record<string, StreamMessage[]> = {
    // Claude: text_delta ×2 → tool_use (content_block_stop) → result
    claude: [
      { type: 'text', content: 'Loo' },
      { type: 'text', content: 'king' },
      { type: 'tool_use', toolName: 'Read', toolInput: { file: 'x' } },
      { type: 'complete' },
    ] as StreamMessage[],
    // Codex: agentMessage/delta ×2 → item/started(mcpToolCall) → turn/completed
    codex: [
      { type: 'text', content: 'Loo' },
      { type: 'text', content: 'king' },
      { type: 'tool_use', toolName: 'apps:read', toolInput: { uri: 'x' } },
      { type: 'complete' },
    ] as StreamMessage[],
  };

  for (const [provider, messages] of Object.entries(NORMALIZED_TURNS)) {
    it(`emits start → text/tool → done for a normalized ${provider} turn`, async () => {
      subscribeAll();
      const mapper = makeMapper(provider);

      mapper.start();
      for (const msg of messages) await mapper.map(msg);
      mapper.finish('completed'); // AgentSession's finally — already latched
      await tick();

      const kinds = frames().map((f) => f.kind);
      // One open, then the turn's content, then exactly one close. Text lands
      // before the tool that followed it: a discrete frame flushes pending deltas.
      expect(kinds).toEqual(['start', 'text', 'tool', 'done']);

      const start = frames()[0];
      expect(start.data).toMatchObject({ provider, messageId: 'msg-7', monitorId: '0' });
      expect(frames().find((f) => f.kind === 'text')?.data).toMatchObject({ delta: 'Looking' });
      expect(frames().at(-1)?.data).toMatchObject({ status: 'completed' });

      // seq stays monotonic across coalescing — a consumer can still detect drops.
      expect(frames().map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    });
  }

  it('publishes exactly one done when the provider completes and the session also finishes', async () => {
    subscribeAll();
    const mapper = makeMapper('claude');

    mapper.start();
    mapper.start(); // a second open must not double the boundary
    await mapper.map({ type: 'complete' } as StreamMessage);
    mapper.finish('completed');
    mapper.finish('interrupted');
    await tick();

    expect(frames().filter((f) => f.kind === 'start')).toHaveLength(1);
    expect(frames().filter((f) => f.kind === 'done')).toHaveLength(1);
  });

  it('closes an interrupted turn that never received a provider terminal', async () => {
    subscribeAll();
    const mapper = makeMapper('codex');

    // The interrupt path: deltas arrive, then the loop breaks — no `complete`
    // ever reaches the mapper, and only `AgentSession.finally` closes the turn.
    mapper.start();
    await mapper.map({ type: 'text', content: 'partial' } as StreamMessage);
    mapper.finish('interrupted');
    await tick();

    const kinds = frames().map((f) => f.kind);
    expect(kinds).toEqual(['start', 'text', 'done']);
    expect(frames().at(-1)?.data).toMatchObject({ status: 'interrupted' });
  });

  it('treats a provider error as the terminal frame and suppresses a later done', async () => {
    subscribeAll();
    const mapper = makeMapper('claude');

    mapper.start();
    await mapper.map({ type: 'error', error: 'boom' } as StreamMessage);
    mapper.finish('completed'); // the finally, after the error already closed the turn
    await tick();

    expect(frames().map((f) => f.kind)).toEqual(['start', 'error']);
    expect(frames().at(-1)?.data).toMatchObject({ error: 'boom' });
  });
});
