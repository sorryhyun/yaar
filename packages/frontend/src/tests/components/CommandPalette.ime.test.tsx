import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useDesktopStore } from '@/store';

const sent: string[] = [];

mock.module('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({
    isConnected: true,
    sendMessage: (msg: string) => sent.push(msg),
    sendWindowMessage: () => {},
    interrupt: () => {},
    reset: () => {},
  }),
}));

const { CommandPalette } = await import('@/components/command-palette/CommandPalette');

/**
 * Reproduces the macOS Korean IME key sequence in Chrome. Typing 안녕 then Enter
 * delivers the composition-commit Enter as keydown(keyCode 229, isComposing) and
 * then, once composition ends, a second real Enter keydown. Submitting on the
 * first one sends the message early and leaves the just-committed trailing
 * character behind, which the second Enter then sends as its own message.
 */
describe('CommandPalette — IME composition', () => {
  beforeEach(() => {
    sent.length = 0;
    useDesktopStore.setState({ activeAgents: {}, hasDrawing: false, windows: {} });
  });

  afterEach(() => cleanup());

  it('does not submit on the composition-commit Enter, then submits once', () => {
    render(<CommandPalette />);
    const textarea = screen.getByRole('textbox');

    // Jamo typed; "녕" is still composing but already present in the value.
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: '안녕' } });

    // The Enter that commits the composition.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(sent).toEqual([]);

    // Composition commits, then the browser delivers the real Enter.
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });

    expect(sent).toEqual(['안녕']);
  });

  it('still submits plain (non-IME) Enter', () => {
    render(<CommandPalette />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });

    expect(sent).toEqual(['hello']);
  });

  it('does not submit on Shift+Enter', () => {
    render(<CommandPalette />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, shiftKey: true });

    expect(sent).toEqual([]);
  });
});
