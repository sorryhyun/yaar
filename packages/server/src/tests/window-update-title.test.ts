/**
 * `update` renames a window.
 *
 * `window.setTitle` has always existed as an OS Action — both window registries apply it,
 * and `subscribe` even offers a "title" event — but no verb emitted it. An agent asked to
 * change what a window shows reached for `update` with a `title`: alongside `operation` the
 * title was silently dropped under a success reply, and on its own the call was refused for
 * lacking `operation`. The agent's only way out was to close the window and open a copy
 * under a new id, losing its subscriptions and reload-cache identity along the way.
 */
import { describe, it, expect } from 'bun:test';
import { runWithAgentContext } from '../agents/agent-context.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { handleUpdate } from '../features/window/update.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

/** Just enough registry for handleUpdate: one unlocked html window. */
const registry = {
  hasWindow: (id: string) => id === 'w1',
  isLockedByOther: () => undefined,
  getWindow: () => ({ content: { renderer: 'html' } }),
} as unknown as WindowStateRegistry;

async function update(payload: Record<string, unknown>) {
  const seen: ActionEvent[] = [];
  const listen = (e: ActionEvent) => seen.push(e);
  actionEmitter.on('action', listen);
  try {
    const result = await runWithAgentContext(
      {
        agentId: 'agent-m0',
        sessionId: 'test-session' as SessionId,
        monitorId: '0',
        role: 'monitor',
      },
      () => handleUpdate(registry, 'w1', payload),
    );
    return { result, actions: seen.map((e) => e.action) };
  } finally {
    actionEmitter.off('action', listen);
  }
}

describe('handleUpdate title', () => {
  it('renames a window with title alone', async () => {
    const { result, actions } = await update({ title: 'Busan weather' });
    expect(result.isError).toBeUndefined();
    expect(actions).toEqual([{ type: 'window.setTitle', windowId: 'w1', title: 'Busan weather' }]);
  });

  it('renames alongside a content operation instead of dropping the title', async () => {
    const { result, actions } = await update({
      operation: 'replace',
      content: '<p>Busan</p>',
      title: 'Busan weather',
    });
    expect(result.isError).toBeUndefined();
    expect(actions.map((a) => a.type)).toEqual(['window.updateContent', 'window.setTitle']);
    expect(actions[1]).toMatchObject({ title: 'Busan weather' });
  });

  it('refuses an empty title rather than blanking the title bar', async () => {
    const { result, actions } = await update({ title: '  ' });
    expect(result.isError).toBe(true);
    expect(actions).toEqual([]);
  });

  it('still refuses a call with neither operation nor title, and names both ways out', async () => {
    const { result, actions } = await update({ content: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('title');
    expect(actions).toEqual([]);
  });
});
