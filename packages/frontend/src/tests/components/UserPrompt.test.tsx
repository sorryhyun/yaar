import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';

const sendUserPromptResponse = mock(
  (
    _prompt: { id: string; title: string; monitorId?: string },
    _answer: { selectedValues?: string[]; text?: string; dismissed?: boolean },
  ) => true,
);

// Stub the connection module — must be before importing UserPrompt
mock.module('@/hooks/useAgentConnection', () => ({ sendUserPromptResponse }));

const { UserPrompt, PromptNotice } = await import('@/components/overlays/UserPrompt');

/** Seeds one prompt, already opened from its notice unless `open` says otherwise. */
function seedPrompt(overrides: Record<string, unknown> = {}, open = true) {
  useDesktopStore.setState({
    userPromptsOpen: open,
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
    expect(sendUserPromptResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      selectedValues: ['a'],
      text: undefined,
    });
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
    expect(sendUserPromptResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      selectedValues: ['b'],
      text: undefined,
    });
  });
});

describe('UserPrompt and Escape', () => {
  beforeEach(() => {
    sendUserPromptResponse.mockClear();
    useDesktopStore.setState({ userPrompts: {} } as never);
  });

  afterEach(() => {
    cleanup();
  });

  // Escape puts the dialog away unanswered; Skip is the button that answers "no".
  it('Escape collapses the dialog back to its notice without answering', () => {
    seedPrompt();
    render(<UserPrompt />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(sendUserPromptResponse).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useDesktopStore.getState().userPromptsOpen).toBe(false);
    expect(useDesktopStore.getState().userPrompts.p1).toBeTruthy();
  });

  it('Skip still tells the agent no', () => {
    seedPrompt();
    render(<UserPrompt />);

    fireEvent.click(screen.getByText('Skip'));

    expect(sendUserPromptResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      dismissed: true,
    });
  });
});

describe('UserPrompt notice', () => {
  beforeEach(() => {
    sendUserPromptResponse.mockClear();
    useDesktopStore.setState({ userPrompts: {}, formFactor: 'desktop' } as never);
  });

  afterEach(() => {
    cleanup();
  });

  // A question used to open as a modal over the whole desktop the moment it was asked.
  it('arrives as a notice, not a dialog', () => {
    seedPrompt({}, false);
    render(
      <>
        <PromptNotice />
        <UserPrompt />
      </>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Pick one'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('floats the notice itself on a phone, where notifications are behind the shade', () => {
    useDesktopStore.setState({ formFactor: 'mobile' } as never);
    seedPrompt({}, false);
    render(<UserPrompt />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Pick one'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('the next question after an answered one arrives as a notice again', () => {
    seedPrompt();
    render(<UserPrompt />);
    fireEvent.click(screen.getByText('Option A'));
    fireEvent.click(screen.getByText('Submit'));

    expect(useDesktopStore.getState().userPromptsOpen).toBe(false);
  });
});
