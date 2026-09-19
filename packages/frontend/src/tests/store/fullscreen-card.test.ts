/**
 * Full-screen phone cards. The flag is sticky state, but it only takes effect while its
 * card is the one on top — so the palette comes back on its own when the card is closed,
 * minimized or covered, and a stale id can never strand the user without an input field.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';
import { selectFullscreenCardId } from '../../store/selectors';

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

const fullscreen = () => selectFullscreenCardId(useDesktopStore.getState());

describe('full-screen card', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      activeMonitorId: '0',
      formFactor: 'mobile',
      fullscreenWindowId: null,
    });
  });

  it('toggles on and off for the focused card', () => {
    create('a');
    useDesktopStore.getState().toggleFullscreenWindow(key('a'));
    expect(fullscreen()).toBe(key('a'));
    useDesktopStore.getState().toggleFullscreenWindow(key('a'));
    expect(fullscreen()).toBeNull();
  });

  it('lapses when another card comes on top, and resumes when it is back', () => {
    create('a');
    useDesktopStore.getState().toggleFullscreenWindow(key('a'));
    create('b'); // b takes focus
    expect(fullscreen()).toBeNull();
    useDesktopStore.getState().userFocusWindow(key('a'));
    expect(fullscreen()).toBe(key('a'));
  });

  it('lapses when the card is minimized or closed', () => {
    create('a');
    useDesktopStore.getState().toggleFullscreenWindow(key('a'));
    useDesktopStore.getState().userMinimizeWindow(key('a'));
    expect(fullscreen()).toBeNull();

    create('b');
    useDesktopStore.getState().toggleFullscreenWindow(key('b'));
    useDesktopStore.getState().userCloseWindow(key('b'));
    expect(fullscreen()).toBeNull();
  });

  it('means nothing on the desktop layout', () => {
    create('a');
    useDesktopStore.getState().toggleFullscreenWindow(key('a'));
    useDesktopStore.setState({ formFactor: 'desktop' });
    expect(fullscreen()).toBeNull();
  });
});
