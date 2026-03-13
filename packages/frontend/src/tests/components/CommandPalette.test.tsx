import { render, screen } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { CommandPalette } from '@/components/command-palette/CommandPalette';

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
      activeAgents: {},
      hasDrawing: false,
      windows: {},
    });
  });

  it('renders the reset button', () => {
    render(<CommandPalette />);
    expect(screen.getByTitle('Reset windows and context')).toBeInTheDocument();
  });

  it('renders the input field', () => {
    render(<CommandPalette />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
