/**
 * The server's mirror of the desktop's stacking order.
 *
 * `WindowStateRegistry.stack` is a second copy of a rule the frontend also implements
 * (`insertIntoZOrder` in `windowsSlice`), which is exactly the kind of duplication that
 * drifts in silence: nothing throws when the two disagree, an agent is simply told the
 * window it is about to write to is on top when the user cannot see it. These tests pin
 * the rules both copies have to satisfy.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction, WindowVariant } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';

function createWindow(id: string, variant?: WindowVariant, minimized?: boolean): OSAction {
  return {
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: { renderer: 'markdown', data: '' },
    ...(variant ? { variant } : {}),
    ...(minimized ? { minimized } : {}),
  };
}

/** Raw ids of one monitor's windows, bottom of the stack first. */
function order(registry: WindowStateRegistry, monitorId = '0'): string[] {
  return registry.stackOrder(monitorId).map((win) => registry.handleMap.getRawWindowId(win.id));
}

describe('WindowStateRegistry stacking', () => {
  it('stacks new windows on top, in creation order', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b'), '0');

    expect(order(registry)).toEqual(['a', 'b']);
    expect(registry.stackIndex('a')).toBe(0);
    expect(registry.stackIndex('b')).toBe(1);
  });

  it('moves a focused window to the top and hands it focus', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b'), '0');
    registry.handleAction({ type: 'window.focus', windowId: 'a' }, '0');

    expect(order(registry)).toEqual(['b', 'a']);
    expect(registry.getFocusedWindowId()).toBe('0/a');
  });

  it('keeps widgets below every standard window', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('standard'), '0');
    // Created last, but a widget may never sit above a standard window.
    registry.handleAction(createWindow('widget', 'widget'), '0');

    expect(order(registry)).toEqual(['widget', 'standard']);
    // ...and focusing it does not promote it out of its layer.
    registry.handleAction({ type: 'window.focus', windowId: 'widget' }, '0');
    expect(order(registry)).toEqual(['widget', 'standard']);
  });

  it('leaves panels out of the stack entirely', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('dock', 'panel'), '0');
    registry.handleAction(createWindow('notes'), '0');

    expect(registry.stackIndex('dock')).toBeUndefined();
    expect(registry.stackIndex('notes')).toBe(0);
    // Still listed — a caller iterating the stack must not lose a window.
    expect(order(registry)).toEqual(['notes', 'dock']);
  });

  it('does not steal focus for a window created minimized', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b', undefined, true), '0');

    expect(registry.getFocusedWindowId()).toBe('0/a');
  });

  it('passes focus down the stack when the focused window is minimized or closed', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b'), '0');
    expect(registry.getFocusedWindowId()).toBe('0/b');

    registry.handleAction({ type: 'window.minimize', windowId: 'b' }, '0');
    expect(registry.getFocusedWindowId()).toBe('0/a');
    expect(registry.getWindow('b')?.minimized).toBe(true);

    registry.handleAction({ type: 'window.close', windowId: 'a' }, '0');
    // `b` is still minimized, so nothing on this desktop is visible to focus.
    expect(registry.getFocusedWindowId()).toBeNull();
  });

  it('tracks minimize and restore, which used to be write-once at create time', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');

    registry.handleAction({ type: 'window.minimize', windowId: 'a' }, '0');
    expect(registry.getWindow('a')?.minimized).toBe(true);

    registry.handleAction({ type: 'window.restore', windowId: 'a' }, '0');
    expect(registry.getWindow('a')?.minimized).toBe(false);
  });

  it('un-minimizes on focus, the way the taskbar button does', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a', undefined, true), '0');

    registry.handleAction({ type: 'window.focus', windowId: 'a' }, '0');
    expect(registry.getWindow('a')?.minimized).toBe(false);
    expect(registry.getFocusedWindowId()).toBe('0/a');
  });

  it('ranks a window among its own monitor, not the session', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b'), '1');
    registry.handleAction(createWindow('c'), '0');

    // Session-wide the stack is a, b, c — but each desktop counts from its own bottom.
    expect(order(registry, '0')).toEqual(['a', 'c']);
    expect(order(registry, '1')).toEqual(['b']);
    expect(registry.stackIndex('0/c')).toBe(1);
    expect(registry.stackIndex('1/b')).toBe(0);
  });

  it('applies a user click-to-focus the same way an agent focus lands', async () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createWindow('a'), '0');
    registry.handleAction(createWindow('b'), '0');

    const applied = await registry.applyUserInteraction(
      { type: 'window.focus', timestamp: 0, windowId: 'a', monitorId: '0' },
      async () => null,
    );

    expect(applied).toEqual([{ type: 'window.focus', windowId: 'a' }]);
    expect(order(registry)).toEqual(['b', 'a']);
    expect(registry.getFocusedWindowId()).toBe('0/a');
  });
});
