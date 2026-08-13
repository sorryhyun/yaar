/**
 * S10 — a prompt says which monitor is asking, and one answer settles it everywhere.
 *
 * A user prompt is deliberately session-scoped: it goes to every connection, because a
 * question only the asking monitor can see is a question that times out unanswered. That
 * decision cost two things, and both showed up as "I answered and nothing happened":
 *
 *  - **Nobody could tell who was asking.** The action carried no monitor, so a prompt from
 *    monitor 1's agent was indistinguishable from one raised by the desktop in front of
 *    you — and answering it sent that agent off to open its windows on a desktop you were
 *    not looking at.
 *  - **Only the tab that answered took the box down.** The expiry path has always emitted
 *    `user.prompt.dismiss`; the *answer* path had no equivalent, so a second tab kept a
 *    live-looking prompt wired to an id that was already resolved. Clicking Submit there
 *    was told the prompt had expired.
 *
 * Both are asserted through two real connections on one session, so what the test reads is
 * what a second browser tab would actually have received.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  ClientEventType,
  ServerEventType,
  type UserPromptShowAction,
  type UserPromptDismissAction,
} from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { actionEmitter } = await import('../../session/action-emitter.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Mint monitor 1 and open a tab on it. */
async function addSecondMonitor(h: Harness) {
  void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
  await expectSettlesWithin(
    h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined),
    1000,
    'the MONITORS frame',
  );
  return h.connect('1');
}

/** Park a turn on `monitorId` inside a real `showUserPrompt`, driven from `client`. */
function askFrom(h: Harness, client: Harness['client'], monitorId: string) {
  h.registry.onTurn(() => [
    {
      kind: 'tool',
      name: 'ask',
      run: () =>
        actionEmitter.showUserPrompt({
          title: 'What should I call it?',
          message: 'Name the file.',
          inputField: { placeholder: 'name', type: 'text' },
        }),
    },
  ]);
  return client.deliverAsync({
    type: ClientEventType.USER_MESSAGE,
    messageId: `m-${monitorId}`,
    monitorId,
    content: 'ask me something',
  });
}

/** The `user.prompt.show` this client has been sent. */
async function awaitShown(client: Harness['client']): Promise<UserPromptShowAction> {
  const frame = await expectSettlesWithin(
    client.waitForFrame(ServerEventType.ACTIONS, (f) =>
      f.actions.some((a) => a.type === 'user.prompt.show'),
    ),
    1000,
    'the prompt reaching this tab',
  );
  return frame.actions.find((a) => a.type === 'user.prompt.show') as UserPromptShowAction;
}

describe('S10.1 — the prompt names the monitor whose agent asked', () => {
  it("a prompt raised on monitor 1 is stamped '1' on every tab that receives it", async () => {
    const h = await boot();
    harness = h;
    const tab1 = await addSecondMonitor(h);

    const turn = askFrom(h, tab1, '1');

    // Both tabs see it — the delivery is session-scoped and stays that way.
    const onTabOne = await awaitShown(tab1);
    const onTabZero = await awaitShown(h.client);

    expect(onTabOne.monitorId).toBe('1');
    // The tab watching monitor 0 is told the same thing, which is the whole point: it is
    // what lets that tab say "monitor 1 is asking" instead of presenting the question as
    // its own.
    expect(onTabZero.monitorId).toBe('1');
    expect(onTabZero.id).toBe(onTabOne.id);

    await tab1.deliver({
      type: ClientEventType.USER_PROMPT_RESPONSE,
      promptId: onTabOne.id,
      text: 'notes.md',
    });
    await expectSettlesWithin(turn, 1000, 'the turn waiting on the prompt');
  });
});

describe('S10.2 — one answer takes the prompt off every screen', () => {
  it('answering on one tab dismisses the prompt on the other', async () => {
    const h = await boot();
    harness = h;
    const tab2 = await h.connect('0');

    const turn = askFrom(h, h.client, '0');
    const shown = await awaitShown(tab2);

    // Armed before the answer goes in, so the assertion cannot be satisfied by a frame
    // that was already sitting in the buffer.
    const dismissed = tab2.waitForFrame(ServerEventType.ACTIONS, (f) =>
      f.actions.some((a) => a.type === 'user.prompt.dismiss'),
    );

    await h.client.deliver({
      type: ClientEventType.USER_PROMPT_RESPONSE,
      promptId: shown.id,
      text: 'notes.md',
    });

    const frame = await expectSettlesWithin(dismissed, 1000, 'the dismiss on the second tab');
    const close = frame.actions.find(
      (a) => a.type === 'user.prompt.dismiss',
    ) as UserPromptDismissAction;
    expect(close.id).toBe(shown.id);

    await expectSettlesWithin(turn, 1000, 'the turn waiting on the prompt');
  });

  it('a late answer to an already-answered prompt raises no dismiss', async () => {
    const h = await boot();
    harness = h;

    const turn = askFrom(h, h.client, '0');
    const shown = await awaitShown(h.client);

    await h.client.deliver({
      type: ClientEventType.USER_PROMPT_RESPONSE,
      promptId: shown.id,
      text: 'notes.md',
    });
    await expectSettlesWithin(turn, 1000, 'the turn waiting on the prompt');

    const dismissesBefore = h.client
      .framesOf(ServerEventType.ACTIONS)
      .filter((f) => f.actions.some((a) => a.type === 'user.prompt.dismiss')).length;

    // The second answer resolves nothing. Broadcasting another dismiss for an id no screen
    // is showing is noise, and would paper over the "expired" notice the user needs.
    await h.client.deliver({
      type: ClientEventType.USER_PROMPT_RESPONSE,
      promptId: shown.id,
      text: 'again',
    });

    const dismissesAfter = h.client
      .framesOf(ServerEventType.ACTIONS)
      .filter((f) => f.actions.some((a) => a.type === 'user.prompt.dismiss')).length;
    expect(dismissesAfter).toBe(dismissesBefore);
  });
});
