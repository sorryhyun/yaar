import { render, screen, fireEvent } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { CommandPalette } from '@/components/ui/CommandPalette';

// Mock useAgentConnection
vi.mock('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({
    isConnected: true,
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      debugPanelOpen: false,
      recentActionsPanelOpen: false,
      sessionsModalOpen: false,
      activeAgents: {},
      hasDrawing: false,
      windows: {},
    });
  });

  it('renders the gear settings button', () => {
    render(<CommandPalette />);
    expect(screen.getByTitle('Settings')).toBeInTheDocument();
  });

  it('renders the reset button directly (not in popover)', () => {
    render(<CommandPalette />);
    expect(screen.getByTitle('Reset windows and context')).toBeInTheDocument();
  });

  it('settings popover is hidden by default', () => {
    render(<CommandPalette />);
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('clicking gear button shows settings popover with config buttons', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByTitle('Settings'));
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Debug')).toBeInTheDocument();
  });

  it('clicking gear button again closes settings popover', () => {
    render(<CommandPalette />);
    const gearBtn = screen.getByTitle('Settings');
    fireEvent.click(gearBtn);
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    fireEvent.click(gearBtn);
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('Sessions/Actions/Debug buttons are not visible outside the popover', () => {
    render(<CommandPalette />);
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Debug')).not.toBeInTheDocument();
  });
});
