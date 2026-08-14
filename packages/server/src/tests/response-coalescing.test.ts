/**
 * The live AGENT_RESPONSE feed is coalesced, and coalescing must not lose text.
 *
 * The event carries the *cumulative* block text rather than a delta, so one event per
 * provider chunk ships O(n²) bytes and costs every connection in the session a store
 * write each time — a cost the CLI panel pays per streaming monitor, since it renders
 * every monitor at once. Because each event supersedes the last, skipping an
 * intermediate one is free; what is *not* free is skipping the final one, which is why
 * every message that ends a text block flushes first.
 *
 * The three ends a block has, all pinned here: a tool call, a clean `complete`, and an
 * interrupt (where the provider sends no terminal message at all and `AgentSession`'s
 * `finally` calls `flushResponse` before closing the turn).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { ServerEventType, type ServerEvent } from '@yaar/shared';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

interface AgentResponse {
  type: typeof ServerEventType.AGENT_RESPONSE;
  content: string;
  isComplete?: boolean;
}

describe('AGENT_RESPONSE coalescing', () => {
  let sent: ServerEvent[];

  beforeEach(() => {
    sent = [];
  });

  function makeMapper() {
    const state = { responseText: '', thinkingText: '', currentMessageId: null };
    return new StreamToEventMapper({
      role: 'monitor-0-msg1',
      providerName: 'claude',
      state,
      sendEvent: async (e: ServerEvent) => {
        sent.push(e);
      },
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
    });
  }

  const responses = (): AgentResponse[] =>
    sent.filter((e): e is ServerEvent & AgentResponse => e.type === ServerEventType.AGENT_RESPONSE);

  const live = () => responses().filter((r) => !r.isComplete);

  const text = (content: string): StreamMessage => ({ type: 'text', content }) as StreamMessage;

  it('collapses a burst of chunks into fewer events than chunks', async () => {
    const mapper = makeMapper();
    for (let i = 0; i < 40; i++) await mapper.map(text('chunk '));

    // The burst runs well inside one 60ms window, so only the first chunk emits.
    expect(live().length).toBeLessThan(40);
    expect(live().length).toBeGreaterThan(0);
  });

  it('emits the whole block before a tool call resets it', async () => {
    const mapper = makeMapper();
    await mapper.map(text('Let me '));
    await mapper.map(text('check that.'));
    await mapper.map({ type: 'tool_use_start', toolName: 'read' } as StreamMessage);

    // Whatever was coalesced away, the last live event carries the finished block —
    // this is what the CLI panel commits to history when the block closes.
    expect(live().at(-1)?.content).toBe('Let me check that.');
  });

  it('emits the whole block before the turn completes', async () => {
    const mapper = makeMapper();
    await mapper.map(text('All '));
    await mapper.map(text('done.'));
    await mapper.map({ type: 'complete', content: '' } as StreamMessage);

    expect(live().at(-1)?.content).toBe('All done.');
    expect(responses().at(-1)?.isComplete).toBe(true);
  });

  it('flushes the tail when a turn ends with no terminal message', async () => {
    const mapper = makeMapper();
    await mapper.map(text('Half a sen'));
    await mapper.map(text('tence and then interrupted'));

    // The interrupt path: no `complete` ever arrives, so AgentSession's `finally`
    // flushes explicitly before latching the turn closed.
    await mapper.flushResponse();

    expect(live().at(-1)?.content).toBe('Half a sentence and then interrupted');
  });
});
