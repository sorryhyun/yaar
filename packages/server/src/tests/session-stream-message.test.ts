/**
 * The provider conversation id travels as its own `session` stream message.
 *
 * It used to ride a content-less fake `text` message, and on `complete` and every
 * `notice` besides, so the mapper checked for it in three branches and the Claude
 * mapper produced a `text` with no text for every assistant frame. Two claims:
 *
 * 1. The mapper hands a `session` message to `onSessionId` and emits nothing for it —
 *    in particular it does not end the text block being coalesced.
 * 2. The Claude provider reports a turn's id once, not once per frame: nearly every SDK
 *    frame carries `session_id`, and the consumer persists what it is handed.
 */
import { describe, it, expect } from 'bun:test';
import type { ServerEvent } from '@yaar/shared';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import { ClaudeSessionProvider } from '../providers/claude/session-provider.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

describe('StreamToEventMapper — session message', () => {
  it('reports the id and emits nothing', async () => {
    const sent: ServerEvent[] = [];
    const ids: string[] = [];
    const state = { responseText: '', thinkingText: '', currentMessageId: null };
    const mapper = new StreamToEventMapper({
      role: 'monitor-0-msg1',
      providerName: 'codex',
      state,
      sendEvent: async (e) => {
        sent.push(e);
      },
      logger: null,
      source: 'yaar://monitors/0' as ContextSource,
      onSessionId: async (id) => {
        ids.push(id);
      },
    });

    await mapper.map({ type: 'session', sessionId: 'thread-1' });

    expect(ids).toEqual(['thread-1']);
    expect(sent).toEqual([]);
    expect(state.responseText).toBe('');
  });
});

describe('ClaudeSessionProvider — session reports', () => {
  async function mapFrames(frames: unknown[]): Promise<StreamMessage[]> {
    const provider = new ClaudeSessionProvider();
    async function* source() {
      yield* frames;
    }
    // The external-turn path maps frames exactly as a YAAR turn does, minus the CLI.
    const mapExternal = (
      provider as unknown as {
        mapExternal(f: AsyncIterable<unknown>): AsyncIterable<StreamMessage>;
      }
    ).mapExternal.bind(provider);
    const out: StreamMessage[] = [];
    for await (const m of mapExternal(source())) out.push(m);
    return out;
  }

  it('reports the id once per turn, ahead of the frames that carry it', async () => {
    const out = await mapFrames([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: {}, session_id: 's1' },
      { type: 'assistant', message: {}, session_id: 's1' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ]);

    expect(out.filter((m) => m.type === 'session')).toEqual([{ type: 'session', sessionId: 's1' }]);
    expect(out[0]).toEqual({ type: 'session', sessionId: 's1' });
    // Nothing else carries it any more, and no content-less `text` is left behind.
    expect(out.filter((m) => m.sessionId && m.type !== 'session')).toEqual([]);
    expect(out.filter((m) => m.type === 'text')).toEqual([]);
    expect(out.at(-1)?.type).toBe('complete');
  });

  it('reports again when a frame names a different conversation', async () => {
    const out = await mapFrames([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: {}, session_id: 's2' },
    ]);

    expect(out).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'session', sessionId: 's2' },
    ]);
  });
});
