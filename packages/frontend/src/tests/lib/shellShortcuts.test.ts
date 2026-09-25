import { describe, expect, it, mock } from 'bun:test';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import {
  applyMonitorStep,
  editableHoldsText,
  handleShellShortcut,
  isCloseWindowShortcut,
  monitorStepDirection,
  resolveCloseTopWindow,
  resolveMonitorStep,
  shouldConfirmUnload,
} from '@/lib/shellShortcuts';
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

describe('shouldConfirmUnload', () => {
  it('prompts while a window is open', () => {
    expect(shouldConfirmUnload(state([win('a')]))).toBe(true);
  });

  it('prompts for a minimized window too — it is still the user’s work', () => {
    expect(shouldConfirmUnload(state([win('a', { minimized: true })]))).toBe(true);
  });

  it('stays quiet on a bare desktop, where the dock is the only thing on screen', () => {
    expect(shouldConfirmUnload(state([]))).toBe(false);
  });
});

describe('monitorStepDirection', () => {
  const key = (
    k: string,
    mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {},
  ) => ({
    key: k,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it('reads Shift+Left/Right as a step', () => {
    expect(monitorStepDirection(key('ArrowLeft'))).toBe(-1);
    expect(monitorStepDirection(key('ArrowRight'))).toBe(1);
  });

  it('leaves every other selection chord alone', () => {
    expect(monitorStepDirection(key('ArrowRight', { ctrlKey: true }))).toBeNull();
    expect(monitorStepDirection(key('ArrowRight', { altKey: true }))).toBeNull();
    expect(monitorStepDirection(key('ArrowRight', { metaKey: true }))).toBeNull();
    expect(monitorStepDirection({ ...key('ArrowRight'), shiftKey: false })).toBeNull();
    expect(monitorStepDirection(key('ArrowUp'))).toBeNull();
  });
});

describe('resolveMonitorStep', () => {
  const monitors = (ids: string[]) =>
    ids.map((id) => ({ id, label: `Monitor ${Number(id) + 1}`, createdAt: 0 }));

  it('steps to the neighbouring monitor', () => {
    const s = { monitors: monitors(['0', '1', '2']), activeMonitorId: '1', maxMonitors: 4 };
    expect(resolveMonitorStep(s, -1)).toEqual({ kind: 'monitor', id: '0' });
    expect(resolveMonitorStep(s, 1)).toEqual({ kind: 'monitor', id: '2' });
  });

  it('makes a new monitor off the right end while the session has room', () => {
    const s = { monitors: monitors(['0', '1']), activeMonitorId: '1', maxMonitors: 4 };
    expect(resolveMonitorStep(s, 1)).toEqual({ kind: 'new' });
  });

  it('stops at the right end of a full session and at the left end always', () => {
    const full = { monitors: monitors(['0', '1']), activeMonitorId: '1', maxMonitors: 2 };
    expect(resolveMonitorStep(full, 1)).toBeNull();
    const first = { monitors: monitors(['0', '1']), activeMonitorId: '0', maxMonitors: 4 };
    expect(resolveMonitorStep(first, -1)).toBeNull();
  });
});

describe('applyMonitorStep', () => {
  const monitors = (ids: string[]) =>
    ids.map((id) => ({ id, label: `Monitor ${Number(id) + 1}`, createdAt: 0 }));
  const store = (ids: string[], activeMonitorId: string, maxMonitors = 4) => ({
    monitors: monitors(ids),
    activeMonitorId,
    maxMonitors,
    createMonitor: mock(() => {}),
    switchMonitor: mock((_id: string) => {}),
  });

  it('switches to the neighbour, creates off the right end, and does nothing at a wall', () => {
    const mid = store(['0', '1', '2'], '1');
    applyMonitorStep(mid, -1);
    expect(mid.switchMonitor).toHaveBeenCalledWith('0');

    const end = store(['0', '1'], '1');
    applyMonitorStep(end, 1);
    expect(end.createMonitor).toHaveBeenCalledTimes(1);
    expect(end.switchMonitor).not.toHaveBeenCalled();

    const wall = store(['0', '1'], '0');
    applyMonitorStep(wall, -1);
    expect(wall.createMonitor).not.toHaveBeenCalled();
    expect(wall.switchMonitor).not.toHaveBeenCalled();
  });
});

describe('handleShellShortcut', () => {
  const key = (
    k: string,
    mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {},
  ) => ({
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  const store = (windows: WindowModel[] = [], monitorIds = ['0', '1']) => ({
    ...state(windows),
    monitors: monitorIds.map((id) => ({ id, label: id, createdAt: 0 })),
    toggleCliMode: mock(() => {}),
    switchMonitor: mock((_id: string) => {}),
    userCloseWindow: mock((_id: string) => {}),
  });

  it('claims the refresh keys and does nothing with them', () => {
    const s = store([win('a')]);
    expect(handleShellShortcut(key('F5'), s)).toBe(true);
    expect(handleShellShortcut(key('r', { ctrlKey: true }), s)).toBe(true);
    expect(s.toggleCliMode).not.toHaveBeenCalled();
    expect(s.userCloseWindow).not.toHaveBeenCalled();
  });

  it('toggles CLI mode on Shift+Tab', () => {
    const s = store();
    expect(handleShellShortcut(key('Tab', { shiftKey: true }), s)).toBe(true);
    expect(s.toggleCliMode).toHaveBeenCalledTimes(1);
    expect(handleShellShortcut(key('Tab'), s)).toBe(false);
  });

  it('switches monitor on Ctrl+digit, and lets the key go when that monitor does not exist', () => {
    const s = store([], ['0', '1']);
    expect(handleShellShortcut(key('2', { ctrlKey: true }), s)).toBe(true);
    expect(s.switchMonitor).toHaveBeenCalledWith('1');
    expect(handleShellShortcut(key('3', { ctrlKey: true }), s)).toBe(false);
    expect(handleShellShortcut(key('2'), s)).toBe(false);
    expect(s.switchMonitor).toHaveBeenCalledTimes(1);
  });

  it('closes the topmost window on Ctrl+W, and claims it on an empty desktop too', () => {
    const s = store([win('a'), win('b')]);
    expect(handleShellShortcut(key('w', { ctrlKey: true }), s)).toBe(true);
    expect(s.userCloseWindow).toHaveBeenCalledWith('b');

    const empty = store();
    expect(handleShellShortcut(key('w', { ctrlKey: true }), empty)).toBe(true);
    expect(empty.userCloseWindow).not.toHaveBeenCalled();
  });

  it('leaves Ctrl+Shift+W and unrelated keys alone', () => {
    const s = store([win('a')]);
    expect(handleShellShortcut(key('W', { ctrlKey: true, shiftKey: true }), s)).toBe(false);
    expect(handleShellShortcut(key('ArrowRight', { shiftKey: true }), s)).toBe(false);
    expect(handleShellShortcut(key('a'), s)).toBe(false);
    expect(s.userCloseWindow).not.toHaveBeenCalled();
  });
});

describe('editableHoldsText', () => {
  it('lets an empty field go, and keeps one that has text to select', () => {
    const input = document.createElement('input');
    expect(editableHoldsText(input)).toBe(false);
    input.value = 'hi';
    expect(editableHoldsText(input)).toBe(true);
    const area = document.createElement('textarea');
    expect(editableHoldsText(area)).toBe(false);
    area.value = 'hi';
    expect(editableHoldsText(area)).toBe(true);
  });

  it('treats a non-editable target as nothing to select', () => {
    expect(editableHoldsText(document.createElement('div'))).toBe(false);
    expect(editableHoldsText(null)).toBe(false);
  });
});
