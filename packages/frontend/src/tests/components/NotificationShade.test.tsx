/**
 * The phone's pull-down, which is now a status surface as well as a notification list.
 *
 * What is worth pinning down is the trade the change made: the desktop's status pill is
 * gone from the phone, so the shade has to be the place those readings are — and it has
 * to still be there to pull down when nothing has been notified, which is exactly what
 * the old "close when the list empties" rule took away.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { NotificationShade } from '@/components/overlays/NotificationShade';
import { DesktopStatusBar } from '@/components/desktop/DesktopStatusBar';
import { SHADE_SETTLE_MS } from '@/lib/gestures';

const noop = mock(() => {});

function open(mobile = true) {
  useDesktopStore.setState({
    formFactor: mobile ? 'mobile' : 'desktop',
    notificationShadeOpen: true,
  });
  return render(<NotificationShade interrupt={noop} interruptAgent={noop} />);
}

describe('NotificationShade', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      notifications: {},
      activeAgents: {},
      windows: {},
      windowAgents: {},
      connectionStatus: 'connected',
      providerType: 'claude',
      notificationShadeOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-shade-pull');
    document.documentElement.style.removeProperty('--shade-pull');
  });

  it('stays open on an empty list, because the status above it is the point', () => {
    open();
    expect(screen.getByText('Connected (claude)')).toBeInTheDocument();
    expect(screen.getByText('No notifications')).toBeInTheDocument();
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
  });

  it('lists the agents the desktop would have shown as chips', () => {
    useDesktopStore.setState({
      activeAgents: {
        'agent-1': {
          id: 'agent-1',
          kind: 'monitor',
          monitorId: '0',
          status: 'Running: Bash',
          statusSince: Date.now(),
          subagentCount: 0,
        },
      } as never,
    });
    open();
    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('Running: Bash')).toBeInTheDocument();
  });

  it('is where a disconnection is reported now that the phone has no status pill', () => {
    useDesktopStore.setState({ connectionStatus: 'disconnected' });
    open();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  describe('the grip', () => {
    /** The sheet, with a height — happy-dom lays nothing out, and the drag measures. */
    function sheetOfHeight(px: number) {
      const sheet = screen.getByRole('dialog');
      Object.defineProperty(sheet, 'offsetHeight', { value: px, configurable: true });
      return screen.getByLabelText('Close notifications');
    }

    const pullPx = () => document.documentElement.style.getPropertyValue('--shade-pull').trim();

    it('pushes the sheet up with the finger, from wherever it already was', () => {
      open();
      const grip = sheetOfHeight(300);
      fireEvent.touchStart(grip, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchMove(grip, { touches: [{ clientX: 200, clientY: 260 }] });
      // 300px of sheet was down and the finger has taken 40 of them back.
      expect(pullPx()).toBe('260px');
    });

    it('puts a sheet back that was only nudged', async () => {
      open();
      const grip = sheetOfHeight(300);
      fireEvent.touchStart(grip, { touches: [{ clientX: 200, clientY: 300 }] });
      // Under `DRAG_INTENT_PX`, so it is a nudge at any speed — the sheet moved with it
      // and moves back, which is how the user finds out the grip is a grip.
      fireEvent.touchMove(grip, { touches: [{ clientX: 200, clientY: 292 }] });
      fireEvent.touchEnd(grip, { changedTouches: [{ clientX: 200, clientY: 292 }] });

      await act(async () => {
        await new Promise((r) => setTimeout(r, SHADE_SETTLE_MS + 40));
      });
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
      expect(document.documentElement.dataset.shadePull).toBe('open');
    });

    it('closes on a push that meant it, and only once the sheet has arrived', async () => {
      open();
      const grip = sheetOfHeight(300);
      fireEvent.touchStart(grip, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchMove(grip, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchEnd(grip, { changedTouches: [{ clientX: 200, clientY: 200 }] });
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);

      await act(async () => {
        await new Promise((r) => setTimeout(r, SHADE_SETTLE_MS + 40));
      });
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
      // And the sheet takes its properties with it, or the next one opens parked.
      expect(document.documentElement.dataset.shadePull).toBeUndefined();
    });

    it('is still a tap: a grip that was not dragged closes on the click', () => {
      open();
      const grip = sheetOfHeight(300);
      fireEvent.touchStart(grip, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(grip, { changedTouches: [{ clientX: 200, clientY: 302 }] });
      fireEvent.click(grip);
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
    });
  });

  /**
   * The navigation the desktop keeps around its input bar. On a phone the bottom edge is
   * the palette's collapsed sheet, so both rows are in here — and they leave the sheet
   * where it is: these are used in runs, and a shade that closed on the first tap would
   * have to be pulled back down for the second.
   */
  describe('the monitor and window rows', () => {
    beforeEach(() => {
      useDesktopStore.setState({
        monitors: [
          { id: '0', label: 'Monitor 1', createdAt: 0 },
          { id: '1', label: 'Monitor 2', createdAt: 0 },
        ],
        activeMonitorId: '0',
        windows: {
          w1: {
            id: 'w1',
            title: 'Notes',
            monitorId: '0',
            bounds: { x: 0, y: 0, w: 400, h: 300 },
            content: { renderer: 'markdown', data: '' },
            minimized: false,
            maximized: false,
          },
        } as never,
        focusedWindowId: null,
      });
    });

    it('carries the monitor switcher and its "+"', () => {
      open();
      expect(screen.getByTitle('Create new monitor')).toBeInTheDocument();
      expect(screen.getByTitle('Monitor 2')).toBeInTheDocument();
    });

    it('carries a tab for every window on the monitor', () => {
      open();
      expect(screen.getByTitle('Notes')).toBeInTheDocument();
    });

    it('raises a window without putting the shade away', () => {
      open();
      fireEvent.click(screen.getByTitle('Notes'));
      expect(useDesktopStore.getState().focusedWindowId).toBe('w1');
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    });

    it('switches monitors without putting the shade away', () => {
      open();
      fireEvent.click(screen.getByTitle('Monitor 2'));
      expect(useDesktopStore.getState().activeMonitorId).toBe('1');
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    });

    it('stays open when a window is closed from its tab', () => {
      open();
      fireEvent.click(screen.getByLabelText('Close Notes'));
      expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    });

    it('says so when the monitor is empty, rather than showing a bare row', () => {
      useDesktopStore.setState({ windows: {} });
      open();
      expect(screen.getByText('No open windows')).toBeInTheDocument();
    });
  });

  it('renders nothing on a desktop, which keeps its status pill', () => {
    const { container } = open(false);
    expect(container.innerHTML).toBe('');
  });
});

describe('DesktopStatusBar on a phone', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      activeAgents: {},
      connectionStatus: 'connected',
      providerType: 'claude',
    });
  });

  afterEach(cleanup);

  it('says nothing at all — the shade has it', () => {
    const { container } = render(<DesktopStatusBar interrupt={noop} interruptAgent={noop} />);
    expect(container.innerHTML).toBe('');
  });

  it('stays quiet even when the connection is down, dot and all', () => {
    useDesktopStore.setState({ connectionStatus: 'disconnected' });
    const { container } = render(<DesktopStatusBar interrupt={noop} interruptAgent={noop} />);
    expect(container.innerHTML).toBe('');
  });
});
