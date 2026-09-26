/**
 * An agent closing a window leaves no handle behind.
 *
 * Agent-emitted actions used to reach the frontend through a per-agent bridge that ran
 * *after* the registry had applied the action, and resolved the window's handle through a
 * lookup that registered on a miss. For a `window.close` the close had just removed the
 * handle, so the bridge filed it straight back: a ghost entry in `WindowHandleMap` for a
 * window that no longer existed. `LiveSession.handleEmittedAction` now delivers every
 * emitted action with the handle it resolved around the registry write.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType, type OSAction } from '@yaar/shared';
import { actionEmitter } from '../../session/action-emitter.js';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Every action of this type that reached the tab, in order. */
function actionsOfType(h: Harness, type: OSAction['type']): OSAction[] {
  return h.client
    .framesOf(ServerEventType.ACTIONS)
    .flatMap((frame) => frame.actions)
    .filter((action) => action.type === type);
}

describe('agent window.close', () => {
  it('removes the handle, and the close goes out under it exactly once', async () => {
    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'open-and-close',
        run: async () => {
          actionEmitter.emitAction({
            type: 'window.create',
            windowId: 'probe',
            title: 'Probe',
            bounds: { x: 0, y: 0, w: 200, h: 100 },
            content: { renderer: 'markdown', data: 'hi' },
          } as OSAction);
          actionEmitter.emitAction({ type: 'window.close', windowId: 'probe' } as OSAction);
          return 'done';
        },
      },
    ]);

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: 'm1',
        monitorId: '0',
        content: 'open and close a window',
      }),
      2000,
      'the turn',
    );

    const creates = actionsOfType(h, 'window.create');
    const closes = actionsOfType(h, 'window.close');
    expect(creates).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect((creates[0] as { windowId: string }).windowId).toBe('0/probe');
    expect((closes[0] as { windowId: string }).windowId).toBe('0/probe');
    // Addressed by the acting agent's role, as the bridge addressed it.
    expect((closes[0] as { agentId?: string }).agentId).toBeTruthy();

    // RED before the fix: the bridge's resolve-or-register lookup re-minted "0/probe".
    expect(h.session.windowState.handleMap.resolve('probe', '0')).toBeUndefined();
  });
});
