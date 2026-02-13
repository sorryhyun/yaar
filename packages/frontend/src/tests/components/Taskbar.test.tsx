import { render, screen, fireEvent } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { Taskbar } from '@/components/ui/Taskbar';

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

  it('renders only the new-monitor button when no minimized windows', () => {
    render(<Taskbar />);
    expect(screen.getByTitle('Create new monitor')).toBeInTheDocument();
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
    const focusSpy = vi.fn();
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
    const closeSpy = vi.fn();
    const focusSpy = vi.fn();
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
