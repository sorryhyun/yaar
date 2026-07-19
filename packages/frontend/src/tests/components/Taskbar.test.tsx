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

describe('Taskbar', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
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
  // taskbar row below it is now minimized-window tabs and nothing else.
  it('renders nothing but window tabs — no monitor controls', () => {
    render(<Taskbar />);
    expect(screen.queryByTitle('Create new monitor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });

  it('renders tabs for each minimized window', () => {
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Notes'),
        w2: createMinimizedWindow('w2', 'Browser', 'html'),
      },
    });

    render(<Taskbar />);
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Browser')).toBeInTheDocument();
  });

  it('does not render non-minimized windows', () => {
    useDesktopStore.setState({
      windows: {
        w1: createMinimizedWindow('w1', 'Minimized'),
        w2: { ...createMinimizedWindow('w2', 'Visible'), minimized: false },
      },
    });

    render(<Taskbar />);
    expect(screen.getByText('Minimized')).toBeInTheDocument();
    expect(screen.queryByText('Visible')).not.toBeInTheDocument();
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
