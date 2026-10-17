/**
 * `invoke('yaar://user/notifications', { duration })` reaches the toast.
 *
 * The invoke schema advertised `duration` ("auto-dismiss after N milliseconds") and the
 * client's NotificationCenter honours it, but the handler built its payload field by field
 * and left `duration` out — so every agent-raised notification stayed up until closed by
 * hand, whatever the agent asked for (GitHub issue #185).
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import { registerUserHandlers } from '../handlers/user.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import type { SessionId } from '../session/types.js';

const registry = new ResourceRegistry();
registerUserHandlers(registry);

/** Invoke as a monitor agent, returning the result and the action it emitted, if any. */
async function notify(payload: Record<string, unknown>) {
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
      () => registry.execute('invoke', 'yaar://user/notifications', payload),
    );
    return { result, action: seen.at(-1)?.action as OSAction | undefined };
  } finally {
    actionEmitter.off('action', listen);
  }
}

describe('yaar://user/notifications invoke', () => {
  it('carries duration onto the notification.show action', async () => {
    const { result, action } = await notify({ title: 'Saved', duration: 4000 });
    expect(result.isError).toBeFalsy();
    expect(action).toMatchObject({ type: 'notification.show', title: 'Saved', duration: 4000 });
  });

  it('omits duration when none was asked for, so the toast stays until closed', async () => {
    const { action } = await notify({ title: 'Sticky' });
    expect(action?.type).toBe('notification.show');
    expect(action).not.toHaveProperty('duration');
  });

  it('refuses a duration the client would silently ignore', async () => {
    for (const duration of [0, -5, '4000', Number.NaN]) {
      const { result, action } = await notify({ title: 'Bad', duration });
      expect(result.isError).toBe(true);
      expect(action).toBeUndefined();
    }
  });
});
