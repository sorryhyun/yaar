import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';

// Mock useAgentConnection — must be before importing CommandPalette
mock.module('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({
    isConnected: true,
    sendMessage: mock(() => {}),
    interrupt: mock(() => {}),
    reset: mock(() => {}),
  }),
}));

const { CommandPalette } = await import('@/components/command-palette/CommandPalette');

describe('CommandPalette', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      activeAgents: {},
      hasDrawing: false,
      windows: {},
    });
  });

  afterEach(() => {
    cleanup();
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
