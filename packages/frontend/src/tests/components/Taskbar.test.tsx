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

  beforeEach(() => {
    useDesktopStore.setState({
      monitors: [monitor('m1', 'Monitor 1')],
      activeMonitorId: 'm1',
    } as any);
  });

  afterEach(() => {
    cleanup();
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
});
