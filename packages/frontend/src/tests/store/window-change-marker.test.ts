import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';

const key = (id: string) => `0/${id}`;

function create(id: string) {
  useDesktopStore.getState().applyAction({
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 300, h: 200 },
    content: { renderer: 'markdown', data: 'hello' },
  });
}

const win = (id: string) => useDesktopStore.getState().windows[key(id)];

describe('window change marker', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      activeMonitorId: '0',
    });
  });

  it('badges an update to a window the user is not in, and clears it on focus', () => {
    create('a');
    create('b'); // b takes focus
    useDesktopStore.getState().applyAction({
      type: 'window.updateContent',
      windowId: key('a'),
      operation: { op: 'append', data: ' world' },
    });
    expect(win('a').changeNonce).toBe(1);
    expect(win('a').unseenChange).toBe(true);

    useDesktopStore.getState().userFocusWindow(key('a'));
    expect(win('a').unseenChange).toBe(false);
  });

  it('glows but does not badge an update to the focused window', () => {
    create('a');
    useDesktopStore.getState().applyAction({
      type: 'window.setContent',
      windowId: key('a'),
      content: { renderer: 'markdown', data: 'new' },
    });
    expect(win('a').changeNonce).toBe(1);
    expect(win('a').unseenChange).toBeFalsy();
  });

  it('badges a focused window that is minimized', () => {
    create('a');
    useDesktopStore.getState().applyAction({ type: 'window.minimize', windowId: key('a') });
    // minimize moves focus away; put it back to prove minimized alone is enough
    useDesktopStore.setState({ focusedWindowId: key('a') });
    useDesktopStore.getState().markWindowChanged(key('a'));
    expect(win('a').unseenChange).toBe(true);
  });

  it('ignores a window that does not exist', () => {
    useDesktopStore.getState().markWindowChanged(key('ghost'));
    expect(useDesktopStore.getState().windows).toEqual({});
  });
});
