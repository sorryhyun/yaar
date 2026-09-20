/**
 * The phone's pull-down, which is now a status surface as well as a notification list.
 *
 * What is worth pinning down is the trade the change made: the desktop's status pill is
 * gone from the phone, so the shade has to be the place those readings are — and it has
 * to still be there to pull down when nothing has been notified, which is exactly what
 * the old "close when the list empties" rule took away.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { NotificationShade } from '@/components/overlays/NotificationShade';
import { DesktopStatusBar } from '@/components/desktop/DesktopStatusBar';

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

  afterEach(cleanup);

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
