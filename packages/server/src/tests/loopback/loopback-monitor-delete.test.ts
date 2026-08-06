/**
 * S9 — deleting a monitor, from both doors.
 *
 * There are two ways a monitor dies: the client's `REMOVE_MONITOR` frame, and the verb
 * `delete('yaar://session/monitors/{id}')` an agent can call. Only one of them used to
 * delete anything. The verb path called `pool.removeMonitorAgent()` and stopped — so the
 * id stayed in `MonitorRegistry`, `getMonitors()` still listed it, the frontend kept
 * rendering the desktop, the connections watching it stayed subscribed, and the next
 * `USER_MESSAGE` on it sailed past the registry's existence check and lazily minted a
 * fresh agent. A deletion that silently undid itself.
 *
 * These pin the two doors to the *same* definition of deletion, which now lives in one
 * place (`MonitorRegistry.remove`). The verb's own business logic (`disposeMonitor`) is
 * what is exercised here rather than the MCP handler above it: the handler is three lines
 * of URI unwrapping over exactly this call, and reaching it would need an agent context
 * this session has no reason to be in.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';

const { disposeMonitor } = await import('../../features/session/monitors.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Mint a second monitor and drive one turn on it, so it has an agent to lose. */
async function bootWithSecondMonitor(): Promise<Harness> {
  const h = await boot();
  harness = h;
  h.registry.onTurn(() => [{ kind: 'text', content: 'hello from the new desktop' }]);

  await h.client.deliver({ type: ClientEventType.ADD_MONITOR });
  expect(h.session.getMonitors().map((m) => m.id)).toEqual(['0', '1']);

  await h.client.deliver({
    type: ClientEventType.USER_MESSAGE,
    messageId: 'm1',
    monitorId: '1',
    content: 'hello',
  });
  expect(h.session.getPool()?.hasMonitorAgent('1')).toBe(true);
  return h;
}

/** The monitor lists the server has broadcast, newest last. */
function broadcastLists(client: Harness['client']): string[][] {
  return client.framesOf(ServerEventType.MONITORS).map((f) => f.monitors.map((m) => m.id));
}

describe('S9 — the verb deletes the monitor, not only its agent', () => {
  it('drops it from the authoritative list and says so on the wire', async () => {
    const h = await bootWithSecondMonitor();

    const result = await disposeMonitor(h.session, '1');

    expect(result.success).toBe(true);
    // The two halves the agent-only teardown skipped: the list the client renders, and
    // the frame that tells it the list changed.
    expect(h.session.getMonitors().map((m) => m.id)).toEqual(['0']);
    expect(broadcastLists(h.client).at(-1)).toEqual(['0']);
    expect(h.session.getPool()?.hasMonitorAgent('1')).toBe(false);
  });

  it('a later message to the deleted monitor is refused, not answered by a new agent', async () => {
    const h = await bootWithSecondMonitor();
    await disposeMonitor(h.session, '1');

    await h.client.deliver({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '1',
      content: 'are you still there?',
    });

    // This is the bug's real cost: the registry check in `handleUserMessage` is what
    // stops the resurrection, and it can only stop it if the deletion reached the
    // registry at all.
    const refusal = h.client.framesOf(ServerEventType.ERROR).find((e) => e.messageId === 'm2');
    expect(refusal?.error).toContain('does not exist');
    expect(h.session.getPool()?.hasMonitorAgent('1')).toBe(false);
  });

  it('refuses the primary desktop and an id the session does not have', async () => {
    const h = await boot();
    harness = h;

    expect(await disposeMonitor(h.session, '0')).toMatchObject({ success: false });
    expect(await disposeMonitor(h.session, '7')).toMatchObject({ success: false });
    expect(h.session.getMonitors().map((m) => m.id)).toEqual(['0']);
  });

  it('does not need an agent: a monitor nobody has messaged is still deletable', async () => {
    const h = await boot();
    harness = h;
    await h.client.deliver({ type: ClientEventType.ADD_MONITOR });

    // Agents are minted on first use, so this monitor has none — the verb used to answer
    // "not found" for exactly the monitors that were cheapest to delete.
    expect(h.session.getPool()?.hasMonitorAgent('1')).toBeFalsy();
    expect(await disposeMonitor(h.session, '1')).toMatchObject({ success: true });
    expect(h.session.getMonitors().map((m) => m.id)).toEqual(['0']);
  });

  it('forgets a disposed agent’s layout state', async () => {
    const h = await bootWithSecondMonitor();
    const layout = h.session.layoutContext;
    const agentId = h.session.getPool()?.agentPool.getMonitorAgent('1')?.instanceId;
    expect(agentId).toBeDefined();

    // The state is only observable through the delta: the first ask reports, the second
    // says "nothing changed". A forgotten agent reports again.
    expect(layout.getMonitorAgentContext(agentId!, '1')).toBeString();
    expect(layout.getMonitorAgentContext(agentId!, '1')).toBeNull();

    await disposeMonitor(h.session, '1');
    expect(layout.getMonitorAgentContext(agentId!, '1')).toBeString();
  });

  it('forgets the removed monitor’s viewport, so its successor does not inherit it', async () => {
    const h = await boot();
    harness = h;
    await h.client.deliver({ type: ClientEventType.ADD_MONITOR });
    await h.client.deliver({
      type: ClientEventType.SUBSCRIBE_MONITOR,
      monitorId: '1',
      viewport: { w: 640, h: 480 },
    });
    expect(h.session.layoutContext.getViewport('1')).toEqual({ w: 640, h: 480 });

    await disposeMonitor(h.session, '1');
    // Ids are the lowest free integer, so the next monitor *is* "1" — and it used to be
    // born 640×480 on a client that had never reported a viewport. `create.ts` reads this
    // to size new windows.
    await h.client.deliver({ type: ClientEventType.ADD_MONITOR });
    expect(h.session.getMonitors().map((m) => m.id)).toEqual(['0', '1']);
    expect(h.session.layoutContext.getViewport('1')).toBeUndefined();
  });
});
