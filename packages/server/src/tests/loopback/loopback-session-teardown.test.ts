/**
 * S11 — a session that is torn down gives its agent slot back, however early it is torn down.
 *
 * `AgentLimiter` is a *process*-global semaphore (`MAX_AGENTS`, default 10), and the only
 * thing that returns a slot is disposing the agent holding it. So a session that ends up
 * owning an agent nobody can reach does not merely leak memory — it permanently shrinks the
 * limit for every session after it, until nothing can create an agent at all.
 *
 * The window for that is the pool's own construction. `routeMessage` and the connection
 * handshake both call `ensureInitialized`, which builds the ContextPool and its monitor
 * agent asynchronously; a client that opens and closes inside that window reaches
 * `cleanup()` while `this.pool` is still null, so cleanup finds nothing to clean and the
 * init assigns a live pool moments later, to a session the hub has already dropped.
 *
 * This is asserted against the limiter rather than against `getPool()` because the limiter
 * is where the damage lands: the orphaned pool is unreachable by definition, so the only
 * observable it leaves is the slot it never gave back. It is also why this suite is worth a
 * file of its own — the symptom shows up in whatever test runs *next*, as an agent that
 * cannot be created, which is a fault it never explains and does not own.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';

const { getAgentLimiter } = await import('../../agents/limiter.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe('S11 — tearing a session down returns its agent slot', () => {
  it('a connect/disconnect that never sends a message leaves the limiter where it found it', async () => {
    const before = getAgentLimiter().getCurrentCount();

    for (let i = 0; i < 3; i++) {
      harness = await boot();
      await harness.dispose();
      harness = undefined;
    }

    // The leak is *deferred*, which is the whole reason it went unnoticed: the orphaned
    // init resolves a tick or two after the dispose that should have waited for it, so an
    // assertion made immediately reads zero and passes for the wrong reason. Let those
    // land before asking.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Not "under the limit" — exactly where it started. One slot per connection is
    // invisible at three iterations and fatal at ten, so the assertion has to be equality.
    expect(getAgentLimiter().getCurrentCount()).toBe(before);
  });

  it('a session torn down after a real turn returns the agent the turn ran on', async () => {
    const before = getAgentLimiter().getCurrentCount();

    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [{ kind: 'text', content: 'done' }]);
    await h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'say something',
    });
    await h.dispose();
    harness = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The other half of the pair: here the pool finished building long before cleanup, so
    // this is the ordinary path — cleanup finds the agent and releases it. Together the two
    // separate "cleanup releases agents" from "cleanup ran early and found none to release".
    expect(getAgentLimiter().getCurrentCount()).toBe(before);
  });
});
