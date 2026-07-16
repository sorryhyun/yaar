/**
 * Stream subscriptions — the transport core (Phase 1).
 *
 * `subscribe(mode:'stream')` widens a change *ping* into a frame *feed*: the server
 * pushes typed {@link StreamFrame}s with payloads, over the very same actionEmitter
 * `'verb-subscription'` channel a change ping rides. These tests pin the guarantees
 * the consumer relies on — monotonic `seq` (so a drop is visible), the `kinds`
 * filter, session scoping, the payload cap — and the isolation that keeps the two
 * modes from crossing wires: a stream sub never gets a bare ping, a change sub never
 * gets a frame.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ServerEventType, type ServerEvent, type StreamFrame } from '@yaar/shared';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';

/** The two events `'verb-subscription'` carries: a stream frame, or a change ping. */
type SubscriptionEvent = Extract<
  ServerEvent,
  { type: typeof ServerEventType.STREAM_FRAME | typeof ServerEventType.VERB_SUBSCRIPTION_UPDATE }
>;

interface Captured {
  sessionId: string;
  event: SubscriptionEvent;
}

/**
 * The frame on a captured event, or undefined if it was a change ping.
 *
 * Only `STREAM_FRAME` carries one — a ping has no payload at all. Reaching for `.frame`
 * on the union is what the old local `{ frame?: StreamFrame }` shape quietly allowed.
 */
const frameOf = (c: Captured): StreamFrame | undefined =>
  c.event.type === ServerEventType.STREAM_FRAME ? c.event.frame : undefined;

describe('stream subscriptions', () => {
  const uri = 'yaar://dev/deploy/demo';
  const sessionId = 'ses-stream-test';
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

  function streamSub(kinds?: string[], sess = sessionId): string {
    const id = subscriptionRegistry.subscribe('tok', 'win-1', sess, uri, 'stream', kinds);
    subIds.push(id);
    return id;
  }

  it('delivers a frame with the payload and a monotonic seq', () => {
    const id = streamSub();
    subscriptionRegistry.publishFrame(uri, 'progress', { step: 'compile' }, sessionId);
    subscriptionRegistry.publishFrame(uri, 'done', { name: 'Demo' }, sessionId);

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first.event.type).toBe(ServerEventType.STREAM_FRAME);
    expect(first.event.subscriptionId).toBe(id);
    expect(frameOf(first)).toMatchObject({
      uri,
      seq: 1,
      kind: 'progress',
      data: { step: 'compile' },
    });
    expect(typeof frameOf(first)?.ts).toBe('number');
    // seq is monotonic per subscription — a gap the consumer sees means a drop.
    expect(frameOf(second)).toMatchObject({ seq: 2, kind: 'done' });
  });

  it('honors the kinds filter — a progress-only sub never sees text frames', () => {
    streamSub(['done', 'error']);
    subscriptionRegistry.publishFrame(uri, 'progress', {}, sessionId);
    subscriptionRegistry.publishFrame(uri, 'done', {}, sessionId);

    expect(captured.map((c) => frameOf(c)?.kind)).toEqual(['done']);
    // A filtered-out frame does not burn a seq the consumer can never see.
    expect(frameOf(captured[0])?.seq).toBe(1);
  });

  it('scopes frames to the publishing session', () => {
    streamSub(undefined, 'ses-A');
    streamSub(undefined, 'ses-B');
    subscriptionRegistry.publishFrame(uri, 'progress', {}, 'ses-A');

    expect(captured).toHaveLength(1);
    expect(captured[0].sessionId).toBe('ses-A');
  });

  it('caps an oversized payload to a truncation marker', () => {
    streamSub();
    const big = 'x'.repeat(5000);
    subscriptionRegistry.publishFrame(uri, 'progress', { blob: big }, sessionId);

    const data = frameOf(captured[0])?.data as { truncated?: boolean; preview?: string };
    expect(data.truncated).toBe(true);
    expect(data.preview?.length).toBe(4096);
  });

  const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

  it('coalesces text deltas within a tick into one merged frame', async () => {
    streamSub();
    subscriptionRegistry.publishFrame(uri, 'text', { delta: 'Hel' }, sessionId);
    subscriptionRegistry.publishFrame(uri, 'text', { delta: 'lo ' }, sessionId);
    subscriptionRegistry.publishFrame(uri, 'text', { delta: 'world' }, sessionId);

    // Nothing delivered synchronously — the deltas are still buffered.
    expect(captured).toHaveLength(0);

    await tick();
    // One frame, deltas merged losslessly, burning exactly one seq (no false gap).
    expect(captured).toHaveLength(1);
    expect(frameOf(captured[0])).toMatchObject({
      seq: 1,
      kind: 'text',
      data: { delta: 'Hello world' },
    });
  });

  it('flushes pending text before a discrete frame so order is preserved', async () => {
    streamSub();
    subscriptionRegistry.publishFrame(uri, 'text', { delta: 'thinking...' }, sessionId);
    // A discrete frame arrives before the coalesce tick — the text must go out first.
    subscriptionRegistry.publishFrame(
      uri,
      'tool',
      { toolName: 'read', status: 'running' },
      sessionId,
    );

    expect(captured.map((c) => frameOf(c)?.kind)).toEqual(['text', 'tool']);
    expect(frameOf(captured[0])?.data).toMatchObject({ delta: 'thinking...' });
    // seq stays monotonic across the flush + the discrete frame.
    expect(captured.map((c) => frameOf(c)?.seq)).toEqual([1, 2]);

    await tick();
    // No late duplicate of the already-flushed text.
    expect(captured).toHaveLength(2);
  });

  it('drops pending coalesced frames on unsubscribe', async () => {
    const id = streamSub();
    subscriptionRegistry.publishFrame(uri, 'text', { delta: 'half a sentence' }, sessionId);
    subscriptionRegistry.unsubscribe(id);
    subIds.splice(subIds.indexOf(id), 1);

    await tick();
    // The buffered delta never fires after teardown.
    expect(captured).toHaveLength(0);
  });

  it('keeps the two modes from crossing wires', () => {
    // A change sub next to a stream sub on the same URI.
    const changeId = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'change');
    subIds.push(changeId);
    streamSub();

    // A frame reaches only the stream sub…
    subscriptionRegistry.publishFrame(uri, 'progress', {}, sessionId);
    expect(captured).toHaveLength(1);
    expect(captured[0].event.type).toBe(ServerEventType.STREAM_FRAME);

    // …and a change ping reaches only the change sub.
    captured = [];
    subscriptionRegistry.notifyChange(uri, sessionId);
    expect(captured).toHaveLength(1);
    expect(captured[0].event.type).toBe(ServerEventType.VERB_SUBSCRIPTION_UPDATE);
    expect(captured[0].event.subscriptionId).toBe(changeId);
  });
});
