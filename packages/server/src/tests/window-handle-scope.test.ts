/**
 * Window IDs are scoped to their monitor.
 *
 * Raw window IDs are derived from the appId (`deriveWindowId`), so the same app
 * open on two monitors carries the same raw ID on both. These tests pin the
 * resolution rules that keep the two copies apart — without them, one monitor's
 * lookup of "devtools" silently lands on the other monitor's window, and every
 * message routed through it drives the wrong monitor's app agent.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowHandleMap } from '../session/window-handle-map.js';
import { WindowStateRegistry } from '../session/window-state.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId } from '../session/types.js';

/** Run `fn` as an agent acting on `monitorId`. */
function onMonitor<T>(monitorId: string, fn: () => T): T {
  return runWithAgentContext(
    { agentId: `agent-m${monitorId}`, sessionId: 'test-session' as SessionId, monitorId },
    fn,
  );
}

function createAppWindow(appId: string): OSAction {
  return {
    type: 'window.create',
    windowId: appId,
    title: appId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
    appId,
  } as OSAction;
}

describe('WindowHandleMap monitor scoping', () => {
  it('keeps a handle per monitor for the same raw ID', () => {
    const map = new WindowHandleMap();
    expect(map.register('devtools', '0')).toBe('0/devtools');
    expect(map.register('devtools', '1')).toBe('1/devtools');

    expect(map.resolve('devtools', '0')).toBe('0/devtools');
    expect(map.resolve('devtools', '1')).toBe('1/devtools');
  });

  it('never resolves a raw ID into a monitor that has no such window', () => {
    const map = new WindowHandleMap();
    map.register('devtools', '0');

    // Monitor 1 has no devtools window — it must not be handed monitor 0's.
    expect(map.resolve('devtools', '1')).toBeUndefined();
    expect(map.has('devtools', '1')).toBe(false);
    expect(map.has('devtools', '0')).toBe(true);
  });

  it('resolves an unambiguous raw ID with no monitor, but refuses to guess an ambiguous one', () => {
    const map = new WindowHandleMap();
    map.register('devtools', '0');
    expect(map.resolve('devtools')).toBe('0/devtools');

    map.register('devtools', '1');
    expect(map.resolve('devtools')).toBeUndefined();
  });

  it('removing one monitor’s window leaves the other monitor’s mapping intact', () => {
    const map = new WindowHandleMap();
    map.register('devtools', '0');
    map.register('devtools', '1');

    map.remove('0/devtools');

    expect(map.resolve('devtools', '0')).toBeUndefined();
    expect(map.resolve('devtools', '1')).toBe('1/devtools');
  });
});

describe('Emitted actions carry the acting monitor', () => {
  /** Emit one action and capture the monitorId the emitter stamped on it. */
  function stampedMonitor(emit: () => void): string | undefined {
    let seen: string | undefined;
    const listener = (event: ActionEvent) => {
      seen = event.monitorId;
    };
    actionEmitter.on('action', listener);
    try {
      emit();
    } finally {
      actionEmitter.off('action', listener);
    }
    return seen;
  }

  it('stamps the monitor from the agent context, not the last provider turn', () => {
    // A window created from monitor 1's dock must land on monitor 1. The iframe
    // runs no provider turn, so the emitter's `currentMonitorId` field still holds
    // whatever monitor last ran — reading it here is what put the window on 0.
    actionEmitter.setCurrentMonitor('0');
    try {
      const monitorId = stampedMonitor(() =>
        runWithAgentContext(
          { agentId: 'iframe:dock', sessionId: 'test-session' as SessionId, monitorId: '1' },
          () => actionEmitter.emitAction(createAppWindow('ai-chat')),
        ),
      );
      expect(monitorId).toBe('1');
    } finally {
      actionEmitter.clearCurrentMonitor();
    }
  });

  it('falls back to the provider-turn monitor when there is no agent context', () => {
    // Codex cannot stamp identity onto MCP requests, so the field remains the fallback.
    actionEmitter.setCurrentMonitor('1');
    try {
      expect(stampedMonitor(() => actionEmitter.emitAction(createAppWindow('ai-chat')))).toBe('1');
    } finally {
      actionEmitter.clearCurrentMonitor();
    }
  });
});

describe('WindowStateRegistry resolves raw IDs on the acting monitor', () => {
  it('gives each monitor its own window for the same app', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(createAppWindow('devtools'), '0');
    reg.handleAction(createAppWindow('devtools'), '1');

    expect(reg.getWindowCount()).toBe(2);
    expect(reg.handleMap.listByMonitor('0')).toEqual(['0/devtools']);
    expect(reg.handleMap.listByMonitor('1')).toEqual(['1/devtools']);
  });

  it('reports the acting monitor as the owner of its own "devtools"', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(createAppWindow('devtools'), '0');
    reg.handleAction(createAppWindow('devtools'), '1');

    // The owning monitor decides which app agent drives the window
    // (AppTaskProcessor.ownerMonitor), so a raw lookup must stay on the caller's.
    expect(onMonitor('0', () => reg.getMonitorForWindow('devtools'))).toBe('0');
    expect(onMonitor('1', () => reg.getMonitorForWindow('devtools'))).toBe('1');

    expect(onMonitor('1', () => reg.getAppIdForWindow('devtools'))).toBe('devtools');
  });

  it('does not surface another monitor’s window to a monitor that has none', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(createAppWindow('devtools'), '0');

    expect(onMonitor('0', () => reg.hasWindow('devtools'))).toBe(true);
    expect(onMonitor('1', () => reg.hasWindow('devtools'))).toBe(false);
    expect(onMonitor('1', () => reg.getMonitorForWindow('devtools'))).toBeUndefined();
  });

  it('one monitor’s App Protocol registration does not mark the other’s window ready', () => {
    // The frontend reports readiness with the monitor-scoped key. If the server
    // collapsed it to the raw id, monitor 0's iframe registering would mark monitor
    // 1's window ready too — and monitor 1's agent would then issue app_commands at
    // an iframe that never registered (the "App did not register" hazard, inverted).
    const reg = new WindowStateRegistry();
    reg.handleAction(createAppWindow('ai-chat'), '0');
    reg.handleAction(createAppWindow('ai-chat'), '1');

    reg.setAppProtocol('0/ai-chat');

    expect(onMonitor('0', () => reg.isAppProtocolWindow('ai-chat'))).toBe(true);
    expect(onMonitor('1', () => reg.isAppProtocolWindow('ai-chat'))).toBe(false);
  });

  it('closing one monitor’s window leaves the other monitor’s open', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(createAppWindow('devtools'), '0');
    reg.handleAction(createAppWindow('devtools'), '1');

    reg.handleAction({ type: 'window.close', windowId: 'devtools' } as OSAction, '0');

    expect(onMonitor('0', () => reg.hasWindow('devtools'))).toBe(false);
    expect(onMonitor('1', () => reg.hasWindow('devtools'))).toBe(true);
    expect(onMonitor('1', () => reg.getMonitorForWindow('devtools'))).toBe('1');
  });
});
