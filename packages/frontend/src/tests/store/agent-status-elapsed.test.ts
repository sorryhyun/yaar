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
