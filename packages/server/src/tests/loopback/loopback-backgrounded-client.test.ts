/**
 * S6 — a desktop that went away is not an app that broke.
 *
 * S5 proves a starved wait ends at its deadline and says something true about it. This is
 * the follow-on: when the reason for the silence is *known*, the wait has to name it,
 * because the two silences call for opposite responses. An app that is wedged is worth a
 * retry, a longer timeout, a look at the app. A tab the browser has stopped running is
 * worth none of those — it will fail identically until the user comes back — and every
 * window in that tab fails at once, which is how one backgrounded phone reads as an entire
 * desktop's worth of broken apps.
 *
 * The thing under test is *not* that a timeout can be avoided. It cannot: a frozen tab
 * keeps its socket open (measured at 264s against real Chrome, well past the transport's
 * own idle timeout, because the server's sends keep resetting the idle clock), so the
 * deadline remains the only thing that ends the wait. What is under test is that the
 * server stops attributing that silence to the app.
 *
 * Hence the control case, which is the half with teeth: a desktop that never said it was
 * away must get the *unchanged* message. A note that appears on every timeout says
 * nothing, and would quietly excuse the genuinely broken app this suite's other half
 * exists to catch.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { resetClientPresenceForTest } = await import('../../session/client-presence.js');

/** Short enough that the deadline passes while the test watches. See S5. */
const DEAD = 80;
const SETTLE_BUDGET = 800;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  resetClientPresenceForTest();
});

/**
 * Run one turn whose only tool asks a registered app that will never answer, and hand back
 * what the agent was told.
 *
 * `presence` is delivered before the turn, exactly as the browser sends it — through the
 * socket, on the real frame — so what is exercised is the whole path and not a registry
 * poked by hand.
 */
async function timeoutTextWithPresence(presence?: 'hidden' | 'frozen' | 'visible') {
  const h = await boot({ deadlines: { appCommandMs: DEAD, appReadyMs: DEAD } });
  harness = h;
  const windowKey = h.seedIframeWindow('ai-chat');
  // Registered, so the command gets past the readiness gate and parks on the reply — the
  // wait this file is about. Same seed as S5's first row.
  await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
  if (presence) {
    await h.client.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: presence });
  }

  h.registry.onTurn((ctx) => [
    {
      kind: 'tool',
      name: 'starved',
      run: () => handleAppCommand(ctx.windowState, windowKey, { command: 'ping' }),
    },
  ]);

  const turn = h.client.deliverAsync({
    type: ClientEventType.USER_MESSAGE,
    messageId: 'm1',
    monitorId: '0',
    content: 'ask the app',
  });
  await expectSettlesWithin(turn, SETTLE_BUDGET, 'the starved turn');

  expect(h.registry.tools).toHaveLength(1);
  const tool = h.registry.tools[0]!;
  expect((tool.result as { isError?: boolean }).isError).toBe(true);
  return tool.text;
}

describe('S6 — a timeout against a backgrounded desktop says so', () => {
  for (const state of ['hidden', 'frozen'] as const) {
    it(`names the tab, not the app, when the desktop reported "${state}"`, async () => {
      const text = await timeoutTextWithPresence(state);

      // Still a timeout, still reported as one — the deadline is not being papered over.
      expect(text).toMatch(/^App did not respond within \d+s\b/);

      // And now the part that changes what the agent does next. Asserted by meaning
      // rather than by re-typing the sentence: what must survive a rewording is that the
      // desktop is named as the cause, and that the two pieces of standing advice for a
      // wedged app — retry, raise the timeout — are withdrawn.
      expect(text).toMatch(/background|frozen/i);
      expect(text).toMatch(/not the app failing/i);
      expect(text).toMatch(/will not help/i);
    });
  }

  it('leaves the message alone when the desktop never said it was away', async () => {
    const text = await timeoutTextWithPresence(undefined);

    expect(text).toMatch(/^App did not respond within \d+s\b/);
    expect(text).toContain('retry with a larger timeoutMs');
    // The whole value of the note is that it is *not* always there.
    expect(text).not.toMatch(/background|frozen/i);
  });

  it('leaves the message alone when the desktop said it was visible', async () => {
    const text = await timeoutTextWithPresence('visible');

    expect(text).toContain('retry with a larger timeoutMs');
    expect(text).not.toMatch(/background|frozen/i);
  });
});
