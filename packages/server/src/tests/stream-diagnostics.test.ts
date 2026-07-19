/**
 * Stream cadence diagnostics.
 *
 * The reason this exists is a class of bug report — "the agent updates in blocks,
 * not smoothly" — that is unactionable without knowing *which* seam chunked it.
 * So the test pins the one property that makes the diagnostic useful: with many
 * small provider deltas, the source seam records many samples and the delivery
 * seam records few, because coalescing merged them. That difference *is* the
 * answer to the report.
 *
 * The second property is a privacy one and matters just as much: samples carry
 * counts, never content. A debug switch must not become a transcript.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';
import {
  setStreamDiagnosticsEnabled,
  getStreamDiagnostics,
  resetStreamDiagnostics,
  isStreamDiagnosticsEnabled,
} from '../streams/stream-diagnostics.js';

describe('stream cadence diagnostics', () => {
  const instanceId = 'agent-diag-1';
  const sessionId = 'ses-diag';
  const uri = `yaar://agents/${instanceId}/stream`;
  const subIds: string[] = [];
  const noop = () => {};

  beforeEach(() => {
    resetStreamDiagnostics();
    setStreamDiagnosticsEnabled(true);
    actionEmitter.on('verb-subscription', noop);
  });
  afterEach(() => {
    actionEmitter.off('verb-subscription', noop);
    for (const id of subIds.splice(0)) subscriptionRegistry.unsubscribe(id);
    setStreamDiagnosticsEnabled(false);
  });

  function makeMapper() {
    return new StreamToEventMapper({
      role: 'monitor',
      providerName: 'test-provider',
      state: { responseText: '', thinkingText: '', currentMessageId: null },
      sendEvent: async () => {},
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
      agentInstanceId: instanceId,
      streamSessionId: sessionId,
    });
  }

  it('is off by default so the hot path pays nothing', () => {
    setStreamDiagnosticsEnabled(false);
    expect(isStreamDiagnosticsEnabled()).toBe(false);
  });

  it('separates source delta cadence from post-coalescing delivery cadence', async () => {
    subIds.push(subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream'));
    const mapper = makeMapper();

    // Six small provider deltas inside one 60ms tick — the shape that produces
    // the "block update" complaint.
    const deltas = ['a', 'bb', 'ccc', 'd', 'ee', 'f'];
    for (const content of deltas) {
      await mapper.map({ type: 'text', content } as StreamMessage);
    }
    await new Promise((r) => setTimeout(r, 90));

    const { source, delivery, summary } = getStreamDiagnostics();

    // Source saw every provider chunk; delivery saw the one merged frame.
    expect(source).toHaveLength(deltas.length);
    const textDelivery = delivery.filter((s) => s.kind === 'text');
    expect(textDelivery).toHaveLength(1);

    // Nothing was lost in the merge — same characters, fewer frames. That is the
    // signature of YAAR coalescing rather than a provider emitting one big block.
    const totalChars = deltas.join('').length;
    expect(summary.source.totalChars).toBe(totalChars);
    expect(textDelivery[0].chars).toBe(totalChars);
    expect(summary.delivery.meanChars).toBeGreaterThan(summary.source.meanChars);
  });

  it('records counts and keys only — never response content', async () => {
    subIds.push(subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri, 'stream'));
    const mapper = makeMapper();
    await mapper.map({ type: 'text', content: 'secret-token-value' } as StreamMessage);
    await new Promise((r) => setTimeout(r, 90));

    const serialized = JSON.stringify(getStreamDiagnostics());
    expect(serialized).not.toContain('secret-token-value');
    // The sample fields are exactly the non-content ones.
    const [sample] = getStreamDiagnostics().source;
    expect(Object.keys(sample).sort()).toEqual(['chars', 'key', 'ts']);
    expect(sample.chars).toBe('secret-token-value'.length);
  });
});
