/**
 * Where a frame on the persistent Claude stream goes, once one pump reads it.
 *
 * With Remote Control on, claude.ai can start turns on the monitor agent's conversation,
 * so "the next frames are the answer to the message I just pushed" stops being true. The
 * frame shapes below are the ones a live CLI (2.1.277) emitted for a claude.ai turn and a
 * YAAR turn on a bridged session:
 *
 * 1. A `command_lifecycle: started` naming a uuid YAAR pushed opens that turn's frames to
 *    its reader; any other uuid opens a detached turn, announced with the replayed prompt.
 * 2. Ownership moves only at `result`: a message folded into a running turn does not split it.
 * 3. A YAAR message folded into a claude.ai turn is answered by that turn's result, so its
 *    reader is released rather than left waiting.
 * 4. Off the bridge nothing is detached: frames with no reader wait for the next turn, as
 *    they did when the turn read the stream itself.
 */
import { describe, expect, it } from 'bun:test';

import { TurnRouter, type DetachedTurn } from '../providers/claude/turn-router.js';

const started = (uuid: string) => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state: 'started',
});
const replay = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  isReplay: true,
  origin: { kind: 'human' },
  message: { role: 'user', content: text },
});
const text = (t: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: t }] },
});
const result = (...uuids: string[]) => ({
  type: 'result',
  subtype: 'success',
  user_message_uuids: uuids,
});

function router(detachable = true) {
  const detached: DetachedTurn[] = [];
  const r = new TurnRouter({ detachable: () => detachable, onDetached: (t) => detached.push(t) });
  return { r, detached };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const f of iterable) out.push(f);
  return out;
}

/** Everything the channel holds right now, without waiting for more. */
async function available(inbox: { iterable: AsyncGenerator<unknown> }, n: number) {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push((await inbox.iterable.next()).value);
  return out;
}

describe('TurnRouter', () => {
  it('gives a YAAR turn exactly its own frames', async () => {
    const { r, detached } = router();
    const inbox = r.openTurn('mine');
    r.markOwn('mine');

    r.route(started('mine'));
    r.route(text('hello'));
    r.route(result('mine'));

    expect(await available(inbox, 3)).toEqual([started('mine'), text('hello'), result('mine')]);
    expect(detached).toHaveLength(0);
  });

  it('announces a claude.ai turn with its prompt and ends it at its result', async () => {
    const { r, detached } = router();

    r.route(started('remote'));
    r.route({ type: 'system', subtype: 'init' });
    r.route(replay('remote', 'say pong'));
    expect(detached).toHaveLength(1);
    expect(detached[0].prompt).toBe('say pong');

    r.route(text('Pong.'));
    r.route(result('remote'));
    r.route({ type: 'command_lifecycle', command_uuid: 'remote', state: 'completed' });

    const frames = await drain(detached[0].frames);
    expect(frames.at(-1)).toEqual(result('remote'));
    expect(frames).toContainEqual(text('Pong.'));
    expect(r.detachedActive).toBe(false);
  });

  it('keeps a claude.ai turn out of a YAAR turn that is waiting behind it', async () => {
    const { r, detached } = router();
    // YAAR pushed while the CLI was about to run the remote message first.
    const inbox = r.openTurn('mine');
    r.markOwn('mine');

    r.route(started('remote'));
    r.route(text('remote answer'));
    r.route(result('remote'));
    r.route(started('mine'));
    r.route(text('my answer'));
    r.route(result('mine'));

    expect(await drain(detached[0].frames)).toEqual([
      started('remote'),
      text('remote answer'),
      result('remote'),
    ]);
    expect(await available(inbox, 3)).toEqual([started('mine'), text('my answer'), result('mine')]);
  });

  it('does not split a turn when a message is folded into it', async () => {
    const { r, detached } = router();
    const inbox = r.openTurn('mine');
    r.markOwn('mine');

    r.route(started('mine'));
    r.route(text('part one'));
    // claude.ai typed mid-turn; the CLI folds it in and announces it.
    r.route(started('remote'));
    r.route(text('part two'));
    r.route(result('mine', 'remote'));

    expect(detached).toHaveLength(0);
    const frames = await available(inbox, 5);
    expect(frames.at(-1)).toEqual(result('mine', 'remote'));
  });

  it('releases a YAAR reader whose message was answered inside a claude.ai turn', async () => {
    const { r, detached } = router();
    r.route(started('remote'));
    r.route(text('working'));
    // A YAAR turn pushes while the remote turn runs, and the CLI folds it in.
    const inbox = r.openTurn('mine');
    r.markOwn('mine');
    r.route(result('remote', 'mine'));

    expect(detached).toHaveLength(1);
    expect(await available(inbox, 1)).toEqual([result('remote', 'mine')]);
  });

  it('keeps frames for the next turn when there is no bridge', async () => {
    const { r, detached } = router(false);
    r.route({ type: 'command_lifecycle', command_uuid: 'x', state: 'completed' });
    r.route(text('late'));

    const inbox = r.openTurn('mine');
    expect(await available(inbox, 2)).toEqual([
      { type: 'command_lifecycle', command_uuid: 'x', state: 'completed' },
      text('late'),
    ]);
    expect(detached).toHaveLength(0);
  });

  it('does not open a turn for status frames between turns', () => {
    const { r, detached } = router();
    r.route({ type: 'system', subtype: 'bridge_state', state: 'connected' });
    r.route({ type: 'command_lifecycle', command_uuid: 'mine', state: 'completed' });
    r.route({ type: 'rate_limit_event' });
    expect(detached).toHaveLength(0);
    expect(r.detachedActive).toBe(false);
  });

  it('ends every reader when the stream ends, including one opened afterwards', async () => {
    const { r, detached } = router();
    const inbox = r.openTurn('mine');
    r.route(started('remote'));
    r.route(text('cut off'));
    r.end();

    expect(await inbox.iterable.next()).toEqual({ value: undefined, done: true });
    expect(await drain(detached[0].frames)).toEqual([started('remote'), text('cut off')]);
    const late = r.openTurn('later');
    expect(await late.iterable.next()).toEqual({ value: undefined, done: true });
  });
});
