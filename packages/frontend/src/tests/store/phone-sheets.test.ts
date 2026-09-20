/**
 * The two phone sheets and the swipe that changes monitor.
 *
 * Both sheets are put away by default and come from opposite edges of the same screen,
 * so the state they share is "only one of us at a time". The monitor step is tested for
 * what it *reports*, not just what it does: the edge swipe uses the answer to decide
 * whether it consumed the touch or should leave it to the page.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';

const monitors = [
  { id: 'a', label: 'Monitor 1', createdAt: 0 },
  { id: 'b', label: 'Monitor 2', createdAt: 0 },
  { id: 'c', label: 'Monitor 3', createdAt: 0 },
];

describe('phone sheets', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      paletteSheetOpen: false,
      notificationShadeOpen: false,
      monitors,
      activeMonitorId: 'a',
    });
  });

  it('starts with both edges put away', () => {
    const s = useDesktopStore.getState();
    expect(s.paletteSheetOpen).toBe(false);
    expect(s.notificationShadeOpen).toBe(false);
  });

  it('raising one puts the other away', () => {
    useDesktopStore.getState().setNotificationShadeOpen(true);
    useDesktopStore.getState().setPaletteSheetOpen(true);
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(true);

    useDesktopStore.getState().setNotificationShadeOpen(true);
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(false);
  });

  it('closing one leaves the other alone', () => {
    useDesktopStore.getState().setPaletteSheetOpen(true);
    useDesktopStore.getState().setNotificationShadeOpen(false);
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(true);
  });
});

describe('switchMonitorBy', () => {
  beforeEach(() => {
    useDesktopStore.setState({ monitors, activeMonitorId: 'a' });
  });

  it('steps along the list and says where it landed', () => {
    expect(useDesktopStore.getState().switchMonitorBy(1)).toBe('b');
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
    expect(useDesktopStore.getState().switchMonitorBy(-1)).toBe('a');
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
  });

  it('reports null at the ends rather than wrapping', () => {
    expect(useDesktopStore.getState().switchMonitorBy(-1)).toBeNull();
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');

    useDesktopStore.setState({ activeMonitorId: 'c' });
    expect(useDesktopStore.getState().switchMonitorBy(1)).toBeNull();
    expect(useDesktopStore.getState().activeMonitorId).toBe('c');
  });

  it('has nowhere to go with one monitor', () => {
    useDesktopStore.setState({ monitors: [monitors[0]], activeMonitorId: 'a' });
    expect(useDesktopStore.getState().switchMonitorBy(1)).toBeNull();
  });
});
