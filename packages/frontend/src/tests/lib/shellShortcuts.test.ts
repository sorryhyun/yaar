import { describe, expect, it } from 'bun:test';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { isCloseWindowShortcut, resolveCloseTopWindow } from '@/lib/shellShortcuts';
import type { WindowModel } from '@/types/state';

function win(id: string, extra: Partial<WindowModel> = {}): WindowModel {
  return {
    id,
    title: id,
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: { renderer: 'text', data: '' },
    minimized: false,
    maximized: false,
    monitorId: DEFAULT_MONITOR_ID,
    ...extra,
  };
}

function state(windows: WindowModel[], appKeybindings: Record<string, string[]> = {}) {
  return {
    windows: Object.fromEntries(windows.map((w) => [w.id, w])),
    zOrder: windows.map((w) => w.id),
    activeMonitorId: DEFAULT_MONITOR_ID,
    appKeybindings,
  };
}

describe('resolveCloseTopWindow', () => {
  it('picks the topmost window, not the one that happens to hold focus', () => {
    expect(resolveCloseTopWindow(state([win('a'), win('b')]))).toBe('b');
  });

  it('skips minimized windows and windows on another monitor', () => {
    const target = resolveCloseTopWindow(
      state([win('a'), win('b', { monitorId: '1' }), win('c', { minimized: true })]),
    );
    expect(target).toBe('a');
  });

  it('closes nothing on an empty desktop — the caller still claims the key', () => {
    expect(resolveCloseTopWindow(state([]))).toBeNull();
  });

  it('yields when the topmost window’s app binds the w key', () => {
    const s = state([win('a'), win('b', { appId: 'writer' })], { writer: ['Ctrl+Shift+W'] });
    expect(resolveCloseTopWindow(s)).toBeNull();
  });

  it('yields for a bare w binding too, and does not fall through to the window below', () => {
    const s = state([win('a'), win('b', { appId: 'writer' })], { writer: ['w'] });
    expect(resolveCloseTopWindow(s)).toBeNull();
  });

  it('closes an app window whose bindings do not touch w', () => {
    const s = state([win('b', { appId: 'reader' })], { reader: ['ArrowRight', 'Ctrl+s'] });
    expect(resolveCloseTopWindow(s)).toBe('b');
  });
});

describe('isCloseWindowShortcut', () => {
  const ev = (over: Partial<Parameters<typeof isCloseWindowShortcut>[0]>) => ({
    key: 'w',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it('matches plain Ctrl+W', () => {
    expect(isCloseWindowShortcut(ev({}))).toBe(true);
  });

  it('leaves Ctrl+Shift+W and Ctrl+Alt+W to the app that bound them', () => {
    expect(isCloseWindowShortcut(ev({ key: 'W', shiftKey: true }))).toBe(false);
    expect(isCloseWindowShortcut(ev({ altKey: true }))).toBe(false);
  });

  it('ignores an unmodified w', () => {
    expect(isCloseWindowShortcut(ev({ ctrlKey: false }))).toBe(false);
  });
});
