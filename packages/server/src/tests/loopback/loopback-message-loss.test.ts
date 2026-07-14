/**
 * S4 — no message is lost, duplicated, or reordered.
 *
 * This file is the guard rail for a refactor nobody has made yet. `routeMessage` currently
 * awaits the entire agent turn before the connection queue moves on, which is the reason a
 * reply to that turn had to be given a bypass. The obvious next thought is "so stop awaiting
 * the turn" — and that thought is only safe if something is watching the properties the
 * await is quietly providing: that every message runs, that it runs once, and that messages
 * from one client run in the order they were sent.
 *
 * Nothing was watching. The existing routing tests assert `expect(mockHandleMessage).
 * toHaveBeenCalled()` against a stub that resolves instantly — under which a dropped
 * message, a doubled message and a reordered message all look identical to a correct one.
 * Here the evidence is what the *provider* was actually handed: `registry.turns` is the
 * prompt of every turn any agent in the session really ran, in the order they started. That
 * is "the user's message got handled", rather than "a mock got poked".
 *
 * If a future change to `routeOne` drops or reorders a message, this is the red light.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType, type ClientEvent } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred, type Deferred } from './harness/deferred.js';
import { expectSettlesWithin } from './harness/liveness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Words no prompt assembles by accident, and no two of which are substrings. */
const MARKERS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

function userMessage(messageId: string, content: string): ClientEvent {
  return { type: ClientEventType.USER_MESSAGE, messageId, monitorId: '0', content };
}

/**
 * Hold the turn whose prompt carries `marker`, and let every other turn run straight
 * through. Holding one turn is what forces the rest to queue — which is the only state in
 * which "in order" and "exactly once" are claims about anything.
 */
function holdTurnFor(h: Harness, marker: string): { entered: Deferred<void>; release: () => void } {
  const entered = deferred<void>();
  const gate = deferred<void>();
  h.registry.onTurn((ctx) =>
    ctx.prompt.includes(marker)
      ? [
          {
            kind: 'tool',
            name: 'held',
            run: async () => {
              entered.resolve();
              await gate.promise;
              return 'released';
            },
          },
        ]
      : [{ kind: 'text', content: 'ok' }],
  );
  return { entered, release: () => gate.resolve() };
}

/** The prompts of the turns that actually ran, in the order they started. */
function promptsOf(h: Harness): string[] {
  return h.registry.turns.map((t) => t.prompt);
}

describe('S4 — every message runs, exactly once, in order', () => {
  it('five messages sent while the first is still running all run, once each, in order', async () => {
    const h = await boot();
    harness = h;
    const held = holdTurnFor(h, MARKERS[0]);

    // All five go out before any of them finishes — the last four queue behind the first.
    const sent = MARKERS.map((marker, i) =>
      h.client.deliverAsync(userMessage(`m${i + 1}`, `message ${marker}`)),
    );
    await expectSettlesWithin(held.entered.promise, 1000, 'the first turn reaching its tool');
    held.release();

    await expectSettlesWithin(Promise.all(sent), 3000, 'the five messages');

    const prompts = promptsOf(h);
    expect(prompts).toHaveLength(5);
    MARKERS.forEach((marker, i) => {
      // Turn i handled message i...
      expect(prompts[i]).toContain(marker);
      // ...and could not have: context flows forward, so a *later* message appearing in an
      // earlier turn's prompt would mean the two had swapped.
      const later = MARKERS[i + 1];
      if (later) expect(prompts[i]).not.toContain(later);
    });

    // And the client was told, once, about each — an unacked message is one the client's
    // outbox will resend forever.
    const acks = h.client.framesOf(ServerEventType.MESSAGE_ACCEPTED);
    for (let i = 0; i < MARKERS.length; i++) {
      const forThis = acks.filter((a) => a.messageId === `m${i + 1}`);
      expect(forThis).toHaveLength(1);
      expect(forThis[0]!.agentId).not.toBe('duplicate');
    }
  });

  it('a message id redelivered mid-flight is re-acked, and does not run twice', async () => {
    const h = await boot();
    harness = h;
    const held = holdTurnFor(h, MARKERS[0]);

    const first = h.client.deliverAsync(userMessage('m1', `message ${MARKERS[0]}`));
    await expectSettlesWithin(held.entered.promise, 1000, 'the first turn reaching its tool');

    // The client's outbox resends: it has had no ack yet, so as far as it knows the message
    // never landed. The server has to recognise its own id and *not* run the turn again —
    // the user would see their question answered twice.
    const resend = h.client.deliverAsync(userMessage('m1', `message ${MARKERS[0]}`));
    held.release();

    await expectSettlesWithin(Promise.all([first, resend]), 2000, 'the message and its resend');

    expect(promptsOf(h)).toHaveLength(1);

    const acks = h.client
      .framesOf(ServerEventType.MESSAGE_ACCEPTED)
      .filter((a) => a.messageId === 'm1');
    expect(acks).toHaveLength(2);
    // The second ack is what makes the outbox let go of a message it has no other way to
    // learn the fate of.
    expect(acks[1]!.agentId).toBe('duplicate');
  });
});

describe('S4 — a disconnect loses neither the queue nor the messages in it', () => {
  it('messages queued when the socket dies still run, and the resend after reconnect does not double them', async () => {
    const h = await boot();
    harness = h;
    const held = holdTurnFor(h, MARKERS[0]);

    const alpha = h.client.deliverAsync(userMessage('m1', `message ${MARKERS[0]}`));
    const bravo = h.client.deliverAsync(userMessage('m2', `message ${MARKERS[1]}`));
    const charlie = h.client.deliverAsync(userMessage('m3', `message ${MARKERS[2]}`));
    await expectSettlesWithin(held.entered.promise, 1000, 'the first turn reaching its tool');

    // The tab goes away with two messages still queued behind the running turn. The session
    // outlives the socket by design — so the work must too.
    await h.client.close();
    held.release();

    await expectSettlesWithin(
      Promise.all([alpha, bravo, charlie]),
      3000,
      'the messages queued when the socket died',
    );
    expect(promptsOf(h)).toHaveLength(3);

    // The user comes back. Their outbox still holds m3: it ran, but its ack was written to a
    // socket that was already gone, so the client never heard it and resends.
    const reconnected = await h.connect();
    await expectSettlesWithin(
      reconnected.deliverAsync(userMessage('m3', `message ${MARKERS[2]}`)),
      2000,
      'the outbox resend of m3',
    );

    expect(promptsOf(h)).toHaveLength(3); // still three — the resend ran nothing
    const acks = reconnected
      .framesOf(ServerEventType.MESSAGE_ACCEPTED)
      .filter((a) => a.messageId === 'm3');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.agentId).toBe('duplicate');

    // And the new connection is a working one, not merely an attached one.
    await expectSettlesWithin(
      reconnected.deliverAsync(userMessage('m4', `message ${MARKERS[3]}`)),
      2000,
      'a new message on the new connection',
    );
    const prompts = promptsOf(h);
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toContain(MARKERS[3]);
  });
});
