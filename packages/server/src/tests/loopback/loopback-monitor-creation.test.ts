/**
 * S8 — a monitor minted while the session is busy.
 *
 * "Add monitor" looks like the safest frame in the protocol: `MonitorRegistry.add()` mints
 * an id and broadcasts a list, and no agent is created until the new monitor's first
 * message arrives. The data structures agree — the monitor queues are per-monitor, the
 * agent maps are keyed by monitor id. On paper nothing can collide.
 *
 * On paper is where every test we had for this stood. `multi-monitor.test.ts` stubs
 * `AgentSession.handleMessage` to resolve instantly, so there is no "busy" to add a monitor
 * during; `monitor-identity.test.ts` adds one with nothing running at all;
 * `ws-head-of-line.test.ts` does hold a turn open, but against a hand-rolled `fakeSession`
 * that has no pool, no agents and no registry — it proves the frame queue lets ADD_MONITOR
 * through, and stops exactly where the interesting part starts.
 *
 * So these three ask what happens on the real stack, in the order a user would hit it:
 * mint a monitor while a turn is parked (S8.1); mint one while the parked turn is waiting
 * on an *app*, and then actually use it (S8.2); and mint one when the global agent limiter
 * has nothing left to give (S8.3).
 *
 * S8.3 is the one that found something. See its own comment.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';
import {
  expectSettlesWithin,
  expectStillPending,
  expectConcurrent,
  flush,
} from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { resetAgentLimiter } = await import('../../agents/limiter.js');

let harness: Harness | undefined;
let restoreMaxAgents: (() => void) | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  restoreMaxAgents?.();
  restoreMaxAgents = undefined;
});

/**
 * Take the global limiter down to `n` slots for one test.
 *
 * Through the env var and `resetAgentLimiter()`, which is the seam the limiter already has
 * for this — no `mock.module`, per the rule this directory lives under. The reset must
 * happen before `boot()`, because the pool reads `getAgentLimiter()` when it creates its
 * first agent, and the restore after `dispose()`, so the session's own release lands on the
 * limiter that issued the slot.
 */
function limitAgentsTo(n: number): () => void {
  const previous = process.env.MAX_AGENTS;
  process.env.MAX_AGENTS = String(n);
  resetAgentLimiter();
  return () => {
    if (previous === undefined) delete process.env.MAX_AGENTS;
    else process.env.MAX_AGENTS = previous;
    resetAgentLimiter();
  };
}

/** The monitor id the server minted and told this tab to go to. */
function focusedMonitor(client: Harness['client']): string | undefined {
  const framed = client.framesOf(ServerEventType.MONITORS).filter((f) => f.focus);
  return framed[framed.length - 1]?.focus;
}

describe('S8.1 — minting a monitor does not wait on the turn already running', () => {
  it('ADD_MONITOR is answered with the new list while monitor 0 is parked mid-tool', async () => {
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
      content: 'take your time',
    });
    await expectSettlesWithin(entered.promise, 1000, 'the turn reaching its tool');

    // Minting a monitor answers no question the running turn asked — but it is also not
    // work the running turn owns, and a user who clicks "add monitor" while the agent is
    // thinking should get a desktop, not a wait. This is the assertion that says so.
    const listed = h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined);
    void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });

    const frame = await expectConcurrent(turn, listed, 1000, 'the MONITORS frame');
    expect(frame.focus).toBe('1');
    expect(frame.monitors.map((m) => m.id)).toEqual(['0', '1']);

    // And the new monitor cost nothing yet: the agent is created lazily, on its first
    // message, so a session with two desktops still has one agent.
    expect(h.session.getPool()?.getMonitorAgentIds()).toEqual(['0']);

    gate.resolve();
    await expectSettlesWithin(turn, 1000, 'the held turn');
  });
});

describe('S8.2 — the new monitor runs while the old one waits on an app', () => {
  it('a message to monitor 1 completes on its own agent while monitor 0 is parked on an app command', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    // Monitor 0's turn calls the app and genuinely parks there — `handleAppCommand` really
    // creates the PendingStore entry, and only an APP_PROTOCOL_RESPONSE settles it. Monitor
    // 1's turn is ordinary.
    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('ask the app')
        ? [
            {
              kind: 'tool',
              name: 'command',
              run: () => handleAppCommand(ctx.windowState, windowKey, { command: 'ping' }),
            },
          ]
        : [{ kind: 'text', content: 'hello from the new desktop' }],
    );

    const asked = h.client.waitForFrame(ServerEventType.APP_PROTOCOL_REQUEST);
    const parked = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the app',
    });
    const request = await expectSettlesWithin(asked, 1000, 'the APP_PROTOCOL_REQUEST');
    await expectStillPending(parked, 'the app-command turn');

    // A second tab mints a monitor and starts using it, all while monitor 0 is stuck.
    void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
    await expectSettlesWithin(
      h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined),
      1000,
      'the MONITORS frame',
    );
    const newMonitor = focusedMonitor(h.client)!;
    expect(newMonitor).toBe('1');

    const tab = await h.connect(newMonitor);
    const fresh = tab.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: newMonitor,
      content: 'anything at all',
    });

    // The whole question. Monitor 0's turn is holding a provider, a queue head and an
    // unanswered app request; monitor 1 must not be behind any of them.
    await expectConcurrent(parked, fresh, 2000, "monitor 1's turn");

    // It ran on its own agent, with its own context — monitor 0's parked prompt is not in
    // it, which is what "the monitors are independent" has to mean to be worth anything.
    const onNewMonitor = h.registry.turns.filter((t) => t.monitorId === newMonitor);
    expect(onNewMonitor).toHaveLength(1);
    expect(onNewMonitor[0]!.prompt).toContain('anything at all');
    expect(onNewMonitor[0]!.prompt).not.toContain('ask the app');
    expect(h.session.getPool()?.getMonitorAgentIds().sort()).toEqual(['0', '1']);

    // And monitor 0 was only ever waiting on the app: answer it and it finishes normally.
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: request.requestId,
      windowId: request.windowId,
      response: { kind: 'command', result: 'pong' },
    });
    await expectSettlesWithin(parked, 2000, 'the app-command turn');
    expect(h.registry.tools.at(-1)!.text).toBe('pong');
  });
});

describe('S8.3 — minting a monitor the limiter cannot staff', () => {
  it('accepts the monitor, refuses the agent, and strands the message on a queue nothing drains', async () => {
    // One slot for the whole process: monitor 0's agent takes it and never gives it back —
    // a monitor agent holds its slot for its lifetime, not for a turn.
    restoreMaxAgents = limitAgentsTo(1);

    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [{ kind: 'text', content: 'ok' }]);

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: 'm1',
        monitorId: '0',
        content: 'first',
      }),
      2000,
      "monitor 0's turn",
    );
    expect(h.session.getPool()?.getMonitorAgentIds()).toEqual(['0']);

    // The mint itself is pure bookkeeping, so it succeeds regardless of the limiter. The
    // user now has a second desktop on screen.
    void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
    await expectSettlesWithin(
      h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined),
      1000,
      'the MONITORS frame',
    );
    const newMonitor = focusedMonitor(h.client)!;

    const tab = await h.connect(newMonitor);
    const stranded = tab.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: newMonitor,
      content: 'hello?',
    });
    await expectSettlesWithin(stranded, 2000, "monitor 1's message");
    await flush();

    // The agent could not be created, and the session says so.
    expect(h.session.getPool()?.getMonitorAgentIds()).toEqual(['0']);
    const errors = [...h.client.sent, ...tab.sent].filter((e) => e.type === ServerEventType.ERROR);
    expect(errors.some((e) => 'error' in e && /[Aa]gent limit/.test(String(e.error)))).toBe(true);

    // This is the finding. `isMonitorAgentBusy` reports a *missing* agent as busy, so the
    // task takes the busy path: steering fails, an ephemeral cannot be created either (same
    // exhausted limiter), and it lands on the monitor's queue. That queue is drained by
    // `processMonitorQueue`, which runs when a turn on that monitor finishes — and no turn
    // on this monitor will ever start. The message is queued forever.
    //
    // The user-visible shape: a new desktop that reports "queued" and then does nothing,
    // for the rest of the session, with no retry and no expiry. The error above is the only
    // signal, and it does not say the message was lost.
    expect(h.registry.turns.filter((t) => t.monitorId === newMonitor)).toHaveLength(0);
    expect(h.session.getPool()!.getOrCreateMonitorQueue(newMonitor).size()).toBeGreaterThan(0);
  });
});
