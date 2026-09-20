import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { Taskbar } from '@/components/taskbar/Taskbar';
import { MonitorTabs } from '@/components/taskbar/MonitorTabs';

function createMinimizedWindow(id: string, title: string, renderer = 'markdown') {
  return {
    id,
    title,
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: { renderer, data: '' },
    minimized: true,
    maximized: false,
  };
}

const open = (id: string, title: string, renderer = 'markdown') => ({
  ...createMinimizedWindow(id, title, renderer),
  minimized: false,
});

describe('Taskbar', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      // Pinned: the selector filters by monitor, and the MonitorTabs block below
      // shares this file's store singleton.
      activeMonitorId: '0',
      focusedWindowId: null,
      notifications: {},
      toasts: {},
      connectionStatus: 'disconnected',
      connectionError: null,
      activityLog: [],
      providerType: null,
      sessionId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  // Monitor controls moved onto the command-palette input bar (MonitorTabs); the
  // taskbar row below it is window tabs and nothing else.
  it('renders nothing but window tabs — no monitor controls', () => {
    render(<Taskbar />);
    expect(screen.queryByTitle('Create new monitor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });

  // The row used to be minimized-only, which left an open-but-buried window with no
  // tab to click and the row silent about what the desktop was holding.
  it('renders a tab for every window, open or minimized', () => {
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Notes'),
        w2: open('w2', 'Browser', 'html'),
      },
    });

    render(<Taskbar />);
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Browser')).toBeInTheDocument();
  });

  it('marks the minimized ones and the focused one apart', () => {
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Put Away'),
        w2: open('w2', 'In Front'),
        w3: open('w3', 'Behind'),
      },
      focusedWindowId: 'w2',
    });

    render(<Taskbar />);
    const tabOf = (title: string) => screen.getByText(title).closest('button')!;
    expect(tabOf('Put Away')).toHaveAttribute('data-minimized');
    expect(tabOf('Put Away')).not.toHaveAttribute('data-active');
    expect(tabOf('In Front')).toHaveAttribute('data-active');
    expect(tabOf('Behind')).not.toHaveAttribute('data-active');
    expect(tabOf('Behind')).not.toHaveAttribute('data-minimized');
  });

  // A window that is focused *and* minimized is not in front of anything, so its tab is
  // the way back — not a second click that puts away what is already away.
  it('treats a focused-but-minimized window as put away', () => {
    const focusSpy = mock(() => {});
    const minimizeSpy = mock(() => {});
    useDesktopStore.setState({
      windows: { w1: createMinimizedWindow('w1', 'Stale Focus') },
      focusedWindowId: 'w1',
      userFocusWindow: focusSpy,
      userMinimizeWindow: minimizeSpy,
    } as any);

    render(<Taskbar />);
    fireEvent.click(screen.getByText('Stale Focus'));
    expect(focusSpy).toHaveBeenCalledWith('w1');
    expect(minimizeSpy).not.toHaveBeenCalled();
  });

  it('does not render windows from another monitor', () => {
    useDesktopStore.setState({
      windows: {
        w1: open('w1', 'Here'),
        w2: { ...open('w2', 'Elsewhere'), monitorId: '1' },
      },
    });

    render(<Taskbar />);
    expect(screen.getByText('Here')).toBeInTheDocument();
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument();
  });

  it('shows renderer-type icon', () => {
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Doc', 'markdown'),
        w2: createMinimizedWindow('w2', 'Web', 'html'),
        w3: createMinimizedWindow('w3', 'Data', 'table'),
      },
    });

    render(<Taskbar />);
    // markdown -> 📄, html -> 🌐, table -> 📊
    expect(screen.getByText('\u{1F4C4}')).toBeInTheDocument();
    expect(screen.getByText('\u{1F310}')).toBeInTheDocument();
    expect(screen.getByText('\u{1F4CA}')).toBeInTheDocument();
  });

  it('click tab restores window via userFocusWindow', () => {
    const focusSpy = mock(() => {});
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Restore Me'),
      },
      userFocusWindow: focusSpy,
    } as any);

    render(<Taskbar />);
    fireEvent.click(screen.getByText('Restore Me'));
    expect(focusSpy).toHaveBeenCalledWith('w1');
  });

  it('click raises a buried window, and clicking the front one puts it away', () => {
    const focusSpy = mock(() => {});
    const minimizeSpy = mock(() => {});
    useDesktopStore.setState({
      windows: { w1: open('w1', 'In Front'), w2: open('w2', 'Behind') },
      focusedWindowId: 'w1',
      userFocusWindow: focusSpy,
      userMinimizeWindow: minimizeSpy,
    } as any);

    render(<Taskbar />);
    fireEvent.click(screen.getByText('Behind'));
    expect(focusSpy).toHaveBeenCalledWith('w2');
    expect(minimizeSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('In Front'));
    expect(minimizeSpy).toHaveBeenCalledWith('w1');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('click close button closes window without restoring', () => {
    const closeSpy = mock(() => {});
    const focusSpy = mock(() => {});
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Close Me'),
      },
      userCloseWindow: closeSpy,
      userFocusWindow: focusSpy,
    } as any);

    render(<Taskbar />);
    const closeBtn = screen.getByRole('button', { name: 'Close Close Me' });
    fireEvent.click(closeBtn);
    expect(closeSpy).toHaveBeenCalledWith('w1');
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

// Lives in this file rather than its own: the frontend suite runs test files
// concurrently against one happy-dom document and one Zustand singleton, so a
// second file mutating monitor state races this one's renders.
describe('MonitorTabs', () => {
  const monitor = (id: string, label: string) => ({ id, label });

  // Store *actions* are singletons too, and a spy left in one is a trap for every file
  // that runs after this one — it calls the action, nothing happens, and the failure
  // lands somewhere else entirely. Put the real ones back.
  const realActions = {
    switchMonitor: useDesktopStore.getState().switchMonitor,
    removeMonitor: useDesktopStore.getState().removeMonitor,
  };

  beforeEach(() => {
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1')],
      activeMonitorId: 'm1',
      // A chip says something different on a phone (see the mobile case below), and the
      // store is a singleton every file in this process shares — so pin the form factor
      // rather than inheriting whatever ran last.
      formFactor: 'desktop',
    } as any);
  });

  afterEach(() => {
    cleanup();
    useDesktopStore.setState(realActions);
  });

  it('shows only the new-monitor button with a single monitor', () => {
    render(<MonitorTabs />);
    expect(screen.getByTitle('Create new monitor')).toBeInTheDocument();
    expect(screen.queryByText('Monitor 1')).not.toBeInTheDocument();
  });

  it('renders a tab per monitor once there is more than one', () => {
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1'), monitor('m2', 'Monitor 2')],
    } as any);

    render(<MonitorTabs />);
    expect(screen.getByText('Monitor 1')).toBeInTheDocument();
    expect(screen.getByText('Monitor 2')).toBeInTheDocument();
  });

  // On a phone these chips live in the shade, under a "Monitors" heading — the word on
  // every chip was that heading repeated across a 412px screen.
  it('drops the "Monitor" prefix on a phone, keeping the label in the tooltip', () => {
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1'), monitor('m2', 'Monitor 2')],
      formFactor: 'mobile',
    } as any);

    render(<MonitorTabs />);
    expect(screen.getByTitle('Monitor 2')).toHaveTextContent(/^2/);
    expect(screen.queryByText('Monitor 2')).not.toBeInTheDocument();
  });

  // A label that is not "Monitor N" has no prefix to drop.
  it('leaves a renamed monitor whole', () => {
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1'), monitor('m2', 'Work')],
      formFactor: 'mobile',
    } as any);

    render(<MonitorTabs />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('hides the new-monitor button at the 4-monitor cap', () => {
    useDesktopStore.setState({
      monitors: ['m1', 'm2', 'm3', 'm4'].map((id, i) => monitor(id, `Monitor ${i + 1}`)),
    } as any);

    render(<MonitorTabs />);
    expect(screen.queryByTitle('Create new monitor')).not.toBeInTheDocument();
  });

  it('clicking a tab switches monitor; clicking its close removes it instead', () => {
    const switchSpy = mock(() => {});
    const removeSpy = mock(() => {});
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1'), monitor('m2', 'Monitor 2')],
      switchMonitor: switchSpy,
      removeMonitor: removeSpy,
    } as any);

    render(<MonitorTabs />);
    fireEvent.click(screen.getByText('Monitor 2'));
    expect(switchSpy).toHaveBeenCalledWith('m2');

    fireEvent.click(screen.getByRole('button', { name: 'Close Monitor 2' }));
    expect(removeSpy).toHaveBeenCalledWith('m2');
    expect(switchSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * On a phone a monitor is thrown away, not clicked away: there is no hover to bring an
   * × out of, so it would have to sit permanently under the thumb that switches monitors.
   */
  describe('the flick-up on a phone', () => {
    const removeSpy = mock(() => {});
    const switchSpy = mock(() => {});

    beforeEach(() => {
      removeSpy.mockClear();
      switchSpy.mockClear();
      useDesktopStore.setState({
        // '0' is the session's own monitor, the one the server refuses to delete.
        monitors: [monitor('0', 'Monitor 1'), monitor('m2', 'Monitor 2')],
        activeMonitorId: '0',
        formFactor: 'mobile',
        removeMonitor: removeSpy,
        switchMonitor: switchSpy,
      } as any);
    });

    const chip = (label: string) => screen.getByTitle(label);

    /** One vertical drag on a chip, start to finish. */
    function flick(el: HTMLElement, dy: number) {
      fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 300 + dy }] });
      fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 300 + dy }] });
    }

    it('carries no close button', () => {
      render(<MonitorTabs />);
      expect(screen.queryByRole('button', { name: 'Close Monitor 2' })).not.toBeInTheDocument();
    });

    it('closes the monitor the chip was thrown off the top', () => {
      render(<MonitorTabs />);
      flick(chip('Monitor 2'), -80);
      expect(removeSpy).toHaveBeenCalledWith('m2');
    });

    // A browser sends a click after a touch it was allowed to keep, and that click would
    // land on the chip that is leaving. Consuming the touchend is what stops it — the
    // test asks the event, since only a real browser would send the click itself.
    it('claims the touch, so no click follows the throw', () => {
      render(<MonitorTabs />);
      const el = chip('Monitor 2');
      fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 220 }] });
      const notConsumed = fireEvent.touchEnd(el, {
        changedTouches: [{ clientX: 100, clientY: 220 }],
      });
      expect(notConsumed).toBe(false);
      expect(switchSpy).not.toHaveBeenCalled();
    });

    // Short *and* slow. A short drag that was fast is a flick and does close the monitor,
    // which is why the wait is what makes this one a nudge.
    it('puts back a chip that was only nudged', async () => {
      render(<MonitorTabs />);
      const el = chip('Monitor 2');
      fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 280 }] });
      expect(el.style.transform).toBe('translateY(-20px)');
      await new Promise((r) => setTimeout(r, 80));
      fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 280 }] });
      expect(removeSpy).not.toHaveBeenCalled();
      expect(el.style.transform).toBe('');
    });

    // A sideways drag is the row scrolling, and the chip must not ride along with it.
    it('leaves a sideways drag to the row', () => {
      render(<MonitorTabs />);
      const el = chip('Monitor 2');
      fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 296 }] });
      fireEvent.touchEnd(el, { changedTouches: [{ clientX: 40, clientY: 296 }] });
      expect(removeSpy).not.toHaveBeenCalled();
      expect(el.style.transform).toBe('');
    });

    // It does not move at all, rather than following the finger and coming back every
    // time: the server would refuse, so the chip should not promise otherwise.
    it('will not lift the session monitor', () => {
      render(<MonitorTabs />);
      const el = chip('Monitor 1');
      flick(el, -80);
      expect(removeSpy).not.toHaveBeenCalled();
      expect(el.style.transform).toBe('');
    });

    it('still switches monitors on a tap', () => {
      render(<MonitorTabs />);
      const el = chip('Monitor 2');
      fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 302 }] });
      fireEvent.click(el);
      expect(switchSpy).toHaveBeenCalledWith('m2');
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });
});
