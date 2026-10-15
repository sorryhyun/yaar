/**
 * Closing an app's last window on a monitor retires its app agent, and the close result
 * says so (issue #180, item 5).
 *
 * The retirement is by design; what was missing is the caller knowing about it. A monitor
 * agent that closes Dev Tools to tidy up and reopens it for a follow-up gets an agent
 * that remembers nothing it built. The close result is the one place that can tell it,
 * and only when it is true: another window of the app still open keeps the agent, and an
 * agent that never ran a turn had nothing to lose.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { handleManage, type AppAgentLookup } from '../features/window/manage.js';
import type { PooledAgent } from '../agents/agent-roster.js';
import type { SessionId } from '../session/types.js';

function openApp(reg: WindowStateRegistry, windowId: string, appId: string, monitorId = '0') {
  reg.handleAction(
    {
      type: 'window.create',
      windowId,
      title: windowId,
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
      appId,
    } as OSAction,
    monitorId,
  );
}

function agents(byKey: Record<string, { hasConversation: boolean }>): AppAgentLookup {
  return {
    get: (monitorId, appId) => {
      const a = byKey[`${monitorId}::${appId}`];
      if (!a) return undefined;
      return { session: { hasConversation: () => a.hasConversation } } as unknown as PooledAgent;
    },
  };
}

const ctx = { agentId: 'monitor:0', sessionId: 'sess-close' as SessionId, monitorId: '0' };

const emitted: OSAction[] = [];
const record = (e: { action: OSAction }) => emitted.push(e.action);
actionEmitter.on('action', record);
afterEach(() => {
  emitted.length = 0;
});

function textOf(result: Awaited<ReturnType<typeof handleManage>>): string {
  return result.content.map((c) => ('text' in c ? c.text : '')).join('');
}

describe('closing a window that retires an app agent', () => {
  it('tells the caller the agent and its context went with it', async () => {
    const reg = new WindowStateRegistry();
    openApp(reg, 'devtools', 'devtools');

    const result = await runWithAgentContext(ctx, () =>
      handleManage(reg, 'devtools', 'close', agents({ '0::devtools': { hasConversation: true } })),
    );

    expect(result.isError ?? false).toBe(false);
    const text = textOf(result);
    expect(text).toContain('retired the "devtools" app agent');
    expect(text).toContain('minimize');
    expect(emitted.map((a) => a.type)).toEqual(['window.close']);
  });

  it('says nothing when another window of the app stays open on the monitor', async () => {
    const reg = new WindowStateRegistry();
    openApp(reg, 'devtools', 'devtools');
    openApp(reg, 'devtools-2', 'devtools');

    const result = await runWithAgentContext(ctx, () =>
      handleManage(reg, 'devtools', 'close', agents({ '0::devtools': { hasConversation: true } })),
    );

    expect(textOf(result)).not.toContain('retired');
  });

  it('counts only windows on the same monitor', async () => {
    const reg = new WindowStateRegistry();
    openApp(reg, 'devtools', 'devtools', '0');
    openApp(reg, 'devtools', 'devtools', '1');

    const result = await runWithAgentContext(ctx, () =>
      handleManage(reg, 'devtools', 'close', agents({ '0::devtools': { hasConversation: true } })),
    );

    expect(textOf(result)).toContain('retired the "devtools" app agent');
  });

  it('says nothing for an agent that never ran a turn, or no agent at all', async () => {
    for (const lookup of [agents({ '0::devtools': { hasConversation: false } }), agents({})]) {
      const reg = new WindowStateRegistry();
      openApp(reg, 'devtools', 'devtools');
      const result = await runWithAgentContext(ctx, () =>
        handleManage(reg, 'devtools', 'close', lookup),
      );
      expect(textOf(result)).toBe('Closed window "yaar://windows/devtools"');
    }
  });
});

describe('minimize', () => {
  it('emits window.minimize and keeps the window', async () => {
    const reg = new WindowStateRegistry();
    openApp(reg, 'devtools', 'devtools');

    const result = await runWithAgentContext(ctx, () =>
      handleManage(reg, 'devtools', 'minimize', agents({})),
    );

    expect(result.isError ?? false).toBe(false);
    expect(emitted.map((a) => a.type)).toEqual(['window.minimize']);
    expect(reg.hasWindow('devtools')).toBe(true);
  });
});
