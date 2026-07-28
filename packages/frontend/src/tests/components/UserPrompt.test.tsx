import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';

const sendUserPromptResponse = mock(
  (_id: string, _values?: string[], _text?: string, _dismissed?: boolean) => {},
);

// Mock useAgentConnection — must be before importing UserPrompt
mock.module('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({ sendUserPromptResponse }),
}));

const { UserPrompt } = await import('@/components/overlays/UserPrompt');

function seedPrompt(overrides: Record<string, unknown> = {}) {
  useDesktopStore.setState({
    userPrompts: {
      p1: {
        id: 'p1',
        title: 'Pick one',
        message: 'Choose an option',
        timestamp: Date.now(),
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B' },
        ],
        ...overrides,
      },
    },
  } as never);
}

describe('UserPrompt option selection', () => {
  beforeEach(() => {
    sendUserPromptResponse.mockClear();
    useDesktopStore.setState({ userPrompts: {} } as never);
  });

  afterEach(() => {
    cleanup();
  });

  // The row and the input each used to call toggleOption, so a click landing on
  // the native control ran it twice and the selection silently cancelled itself.
  it('selects when the click lands on the radio itself', () => {
    seedPrompt();
    render(<UserPrompt />);

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(radios[0]);

    expect(radios[0].checked).toBe(true);
    const submit = screen.getByText('Submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(sendUserPromptResponse).toHaveBeenCalledWith('p1', ['a'], undefined);
  });

  it('selects when the click lands on the row label text', () => {
    seedPrompt();
    render(<UserPrompt />);

    fireEvent.click(screen.getByText('Option B'));

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[1].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
  });

  it('single-select replaces the previous choice', () => {
    seedPrompt();
    render(<UserPrompt />);

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(radios[0]);
    fireEvent.click(radios[1]);

    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
  });

  // Clicking a checked radio fires no change event, which is why the handler is
  // on click — deselecting has to keep working.
  it('single-select deselects when the same option is clicked again', () => {
    seedPrompt();
    render(<UserPrompt />);

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(radios[0]);
    fireEvent.click(radios[0]);

    expect(radios[0].checked).toBe(false);
    expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('multi-select accumulates and removes independently', () => {
    seedPrompt({ multiSelect: true });
    render(<UserPrompt />);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(true);

    fireEvent.click(boxes[0]);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);

    fireEvent.click(screen.getByText('Submit'));
    expect(sendUserPromptResponse).toHaveBeenCalledWith('p1', ['b'], undefined);
  });
});
