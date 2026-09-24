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
      orientation: 'portrait',
      fullscreenWindowId: null,
      fullscreenDeclinedId: null,
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

  describe('app requests (yaar.device.setFullscreen)', () => {
    const request = (id: string, on: boolean) =>
      useDesktopStore.getState().requestAppFullscreen(key(id), on);

    it('enters and leaves for the card on top', () => {
      create('a');
      request('a', true);
      expect(fullscreen()).toBe(key('a'));
      request('a', false);
      expect(fullscreen()).toBeNull();
    });

    it('cannot take full screen from a card underneath, nor clear another card', () => {
      create('a');
      create('b'); // b on top
      useDesktopStore.getState().toggleFullscreenWindow(key('b'));
      request('a', true);
      expect(fullscreen()).toBe(key('b'));
      request('a', false);
      expect(fullscreen()).toBe(key('b'));
    });

    it('is refused on the desktop layout', () => {
      create('a');
      useDesktopStore.setState({ formFactor: 'desktop' });
      request('a', true);
      expect(useDesktopStore.getState().fullscreenWindowId).toBeNull();
    });

    it("lets the user's exit stick until the device turns", () => {
      create('a');
      request('a', true);
      // The user presses Back (or the title bar button): the app cannot take it back.
      useDesktopStore.getState().toggleFullscreenWindow(key('a'));
      request('a', true);
      expect(fullscreen()).toBeNull();
      // Turning the device to the same orientation is not a turn.
      useDesktopStore.getState().setOrientation('portrait');
      request('a', true);
      expect(fullscreen()).toBeNull();
      useDesktopStore.getState().setOrientation('landscape');
      request('a', true);
      expect(fullscreen()).toBe(key('a'));
    });

    it("an app's own exit does not count as the user's", () => {
      create('a');
      request('a', true);
      request('a', false);
      request('a', true);
      expect(fullscreen()).toBe(key('a'));
    });
  });
});
