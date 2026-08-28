/**
 * `statusSince` — the clock behind the status bar's elapsed counter.
 *
 * The counter exists because the status label is last-event-wins with no heartbeat: a
 * phase that has gone silent renders exactly like one that is streaming. What makes the
 * number meaningful is that it survives re-assertion — a provider re-asserting
 * "Responding..." every 60ms must not keep resetting it to zero, or a stalled phase
 * always reads as fresh. That is the same early-return that keeps Immer from re-rendering
 * every subscriber per token, so these two behaviours are load-bearing for each other.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';

describe('Agent status elapsed clock', () => {
  beforeEach(() => {
    useDesktopStore.setState({ activeAgents: {} });
  });

  it('stamps statusSince when an agent first becomes active', () => {
    const before = Date.now();
    useDesktopStore.getState().setAgentActive('a1', 'Thinking...');
    const agent = useDesktopStore.getState().activeAgents.a1;

    expect(agent.statusSince).toBeGreaterThanOrEqual(before);
    expect(agent.statusSince).toBeLessThanOrEqual(Date.now());
  });

  it('holds statusSince while the same status is re-asserted', async () => {
    useDesktopStore.getState().setAgentActive('a1', 'Responding...');
    const first = useDesktopStore.getState().activeAgents.a1.statusSince;

    await new Promise((r) => setTimeout(r, 5));
    useDesktopStore.getState().setAgentActive('a1', 'Responding...');
    useDesktopStore.getState().setAgentActive('a1', 'Responding...');

    expect(useDesktopStore.getState().activeAgents.a1.statusSince).toBe(first);
  });

  it('advances statusSince when the phase actually changes', async () => {
    useDesktopStore.getState().setAgentActive('a1', 'Thinking...');
    const first = useDesktopStore.getState().activeAgents.a1.statusSince;

    await new Promise((r) => setTimeout(r, 5));
    useDesktopStore.getState().setAgentActive('a1', 'Running: Bash');

    expect(useDesktopStore.getState().activeAgents.a1.statusSince).toBeGreaterThan(first);
  });

  it('keeps startedAt on the turn while statusSince tracks the phase', async () => {
    useDesktopStore.getState().setAgentActive('a1', 'Thinking...');
    const { startedAt } = useDesktopStore.getState().activeAgents.a1;

    await new Promise((r) => setTimeout(r, 5));
    useDesktopStore.getState().setAgentActive('a1', 'Reasoning...');
    const agent = useDesktopStore.getState().activeAgents.a1;

    expect(agent.startedAt).toBe(startedAt);
    expect(agent.statusSince).toBeGreaterThan(agent.startedAt);
  });
});

/**
 * What the status bar colors and numbers each chip by. Both come off events the store
 * already receives — the tier is read from the role the wire calls `agentId`, the
 * monitor is passed through — so neither costs a round trip to place an agent.
 */
describe('Agent tier and monitor', () => {
  beforeEach(() => {
    useDesktopStore.setState({ activeAgents: {} });
  });

  it('reads the tier off the role', () => {
    useDesktopStore.getState().setAgentActive('monitor-1-msg1', 'Thinking...', '1');
    useDesktopStore.getState().setAgentActive('app-notes-m0-msg2', 'Thinking...', '0');
    useDesktopStore.getState().setAgentActive('app-persona-chitchats-ada', 'Thinking...', '0');

    const agents = useDesktopStore.getState().activeAgents;
    expect(agents['monitor-1-msg1'].kind).toBe('monitor');
    expect(agents['app-notes-m0-msg2'].kind).toBe('app');
    expect(agents['app-persona-chitchats-ada'].kind).toBe('persona');
    expect(agents['monitor-1-msg1'].monitorId).toBe('1');
  });

  it('keeps the monitor when a later event omits it', () => {
    useDesktopStore.getState().setAgentActive('monitor-2-msg1', 'Thinking...', '2');
    useDesktopStore.getState().setAgentActive('monitor-2-msg1', 'Running: Bash');

    expect(useDesktopStore.getState().activeAgents['monitor-2-msg1'].monitorId).toBe('2');
  });

  it('learns a monitor that arrives after the first event, despite the coalescing', () => {
    // The status is identical, so the re-render guard would otherwise drop this write
    // and the agent's chip would never get its number.
    useDesktopStore.getState().setAgentActive('monitor-3-msg1', 'Thinking...');
    useDesktopStore.getState().setAgentActive('monitor-3-msg1', 'Thinking...', '3');

    expect(useDesktopStore.getState().activeAgents['monitor-3-msg1'].monitorId).toBe('3');
  });
});
