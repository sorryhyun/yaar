/**
 * S8 — a snapshot names a busy agent by the same key its streaming events use.
 *
 * The client tracks "who is working" from two sources: the streaming events of a turn
 * (`AGENT_THINKING` … `AGENT_RESPONSE { isComplete }`), keyed by the turn's role, and the
 * resync snapshot, which rebuilds the list from the server's roster. The snapshot used to
 * key by the pool's instanceId. So a phone that came back mid-turn got a row under
 * `agent-2-…`, and the completion a moment later cleared `monitor-…` — a key that row did
 * not have. The row stayed on screen with its timer ticking for an agent that had finished
 * (#113), until the next resync happened to run.
 *
 * The resync here comes from a second connection, which is what a returning phone is: a
 * new socket, whose RESYNC is not queued behind the first socket's running turn.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';
import { expectSettlesWithin } from './harness/liveness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe('S8 — snapshot agent ids match streaming agent ids', () => {
  it('a mid-turn resync reports the busy agent under the key its completion will clear', async () => {
    const h = await boot();
    harness = h;

    const entered = deferred<void>();
    const gate = deferred<void>();
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'held',
        run: async () => {
          entered.resolve();
          await gate.promise;
          return 'done';
        },
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'take a while',
    });
    await expectSettlesWithin(entered.promise, 1000, 'the turn reaching its tool');

    const phone = await h.connect('0');
    await expectSettlesWithin(
      phone.deliverAsync({ type: ClientEventType.RESYNC }),
      1000,
      'the mid-turn RESYNC',
    );
    const snap = phone.framesOf(ServerEventType.SNAPSHOT).at(-1);
    expect(snap).toBeDefined();
    const busy = snap!.agents.filter((a) => a.monitorId === '0');
    expect(busy).toHaveLength(1);

    gate.resolve();
    await expectSettlesWithin(turn, 1000, 'the held turn');

    const completion = h.client
      .framesOf(ServerEventType.AGENT_RESPONSE)
      .find((frame) => frame.isComplete);
    expect(completion).toBeDefined();
    // RED before the fix: the snapshot said `agent-…` (an instanceId) and the completion
    // said the role, so the client's clearAgent(role) left the snapshot's row behind.
    expect(busy[0]!.agentId).toBe(completion!.agentId!);
  });
});
