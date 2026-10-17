/**
 * How an escape-guard retry ends.
 *
 * A trip interrupts the turn and pushes a correction onto the same stream, then
 * swallows "the interrupted turn's terminal" so the retry stays one turn. That
 * held only while the CLI answered the two separately. A CLI that folds the
 * correction into the interrupted command answers both with one `result` —
 * swallowing it left the monitor's turn waiting on a stream with nothing more
 * to send, every later message queued behind it, and stop unable to end it
 * (issue #183, item 1). Three claims:
 *
 * 1. A `result` naming the correction in `user_message_uuids` ends the turn.
 * 2. A swallowed terminal nothing follows ends the turn at the deadline.
 * 3. An acknowledged interrupt that does not end the turn closes the stream.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { ClaudeSessionProvider } from '../providers/claude/session-provider.js';
import { TurnRouter } from '../providers/claude/turn-router.js';
import { TurnGate } from '../providers/turn-gate.js';
import type { StreamMessage, TransportOptions } from '../providers/types.js';

const BS = String.fromCharCode(92);
/** Escape text for every code unit of `s`, built rather than typed (see claude-escape-guard.test.ts). */
const escapeAll = (s: string) =>
  Array.from(s, (c) => `${BS}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

const OPTIONS = { systemPrompt: 'sp', conversation: { kind: 'new' } } as TransportOptions;
/** `turnFingerprint(OPTIONS)` — a match keeps the fake session rather than opening a CLI. */
const FINGERPRINT = ['sp', '', '', ''].join('\u0000');

const streamEvent = (event: unknown) => ({ type: 'stream_event', event, session_id: 's' });
const trippingFrames = [
  streamEvent({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', name: 'mcp__verbs__invoke', id: 'tu_0' },
  }),
  streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: `{"uri":"yaar://x","text":"` },
  }),
  streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: escapeAll('안녕하세요') },
  }),
];
const result = (uuids?: string[]) => ({
  type: 'result',
  subtype: 'success',
  session_id: 's',
  ...(uuids ? { user_message_uuids: uuids } : {}),
});

/**
 * A persistent session whose CLI is `script`: called with each message the
 * provider pushes and its index, it answers by routing frames.
 */
function scriptedSession(
  script: (pushed: { uuid: string }, index: number, route: (f: unknown) => void) => void,
) {
  const pushed: { uuid: string }[] = [];
  const router = new TurnRouter({ detachable: () => false, onDetached: () => {} });
  const abortController = new AbortController();
  const session = {
    turns: new TurnGate(),
    fingerprint: FINGERPRINT,
    openedWithResume: undefined,
    turnsProcessed: 1,
    mcpReady: Promise.resolve(),
    abortController,
    pumpDone: false,
    pumpError: undefined,
    router,
    channel: {
      push: (message: { uuid: string }) => {
        pushed.push(message);
        script(message, pushed.length - 1, (f) => router.route(f));
      },
      close: () => {},
    },
    stream: {
      interrupt: async () => ({ still_queued: [] }),
      return: async () => {},
    },
  };
  // What the pump does when the process goes away.
  abortController.signal.addEventListener('abort', () => router.end());
  return { session, pushed };
}

function setPersistentSession(provider: ClaudeSessionProvider, value: unknown): void {
  (provider as unknown as { persistentSession: unknown }).persistentSession = value;
}

async function collect(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

afterEach(() => {
  jest.useRealTimers();
});

describe('escape retry', () => {
  it('ends on a result that answered the folded correction', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, pushed } = scriptedSession((message, index, route) => {
      if (index === 0) {
        route({ type: 'command_lifecycle', state: 'started', command_uuid: message.uuid });
        for (const f of trippingFrames) route(f);
      } else {
        route(result([pushed[0].uuid, message.uuid]));
      }
    });
    setPersistentSession(provider, session);

    const messages = await collect(provider.query('hi', OPTIONS));

    expect(pushed).toHaveLength(2);
    expect(messages.at(-1)?.type).toBe('complete');
    expect(session.turns.active).toBe(false);
  });

  it('still swallows the interrupted terminal when the correction runs on its own', async () => {
    const provider = new ClaudeSessionProvider();
    const { session, pushed } = scriptedSession((message, index, route) => {
      if (index === 0) {
        for (const f of trippingFrames) route(f);
        return;
      }
      route(result([pushed[0].uuid]));
      route({ type: 'command_lifecycle', state: 'started', command_uuid: message.uuid });
      route(
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      );
      route(
        streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'fixed' },
        }),
      );
      route(result([message.uuid]));
    });
    setPersistentSession(provider, session);

    const messages = await collect(provider.query('hi', OPTIONS));

    expect(messages.filter((m) => m.type === 'complete')).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain('fixed');
  });

  it('ends on the held terminal when nothing follows it', async () => {
    jest.useFakeTimers();
    const provider = new ClaudeSessionProvider();
    const { session } = scriptedSession((_message, index, route) => {
      if (index === 0) for (const f of trippingFrames) route(f);
      // A CLI that folds without saying so: one result, no uuids, then silence.
      else route(result());
    });
    setPersistentSession(provider, session);

    const done = collect(provider.query('hi', OPTIONS));
    let settled = false;
    void done.then(() => (settled = true));
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(60_000);
    const messages = await done;
    expect(messages.at(-1)?.type).toBe('complete');
  });
});

describe('interrupt during a turn the CLI has nothing left for', () => {
  it('closes the stream when the acknowledged turn does not end', async () => {
    const provider = new ClaudeSessionProvider();
    const { session } = scriptedSession(() => {});
    session.turns.begin().start();
    setPersistentSession(provider, session);

    const receipt = await provider.interrupt();

    expect(receipt.outcome).toBe('escalated');
    expect(session.abortController.signal.aborted).toBe(true);
  }, 10_000);
});
