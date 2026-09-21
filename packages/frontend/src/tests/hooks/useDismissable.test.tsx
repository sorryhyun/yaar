/**
 * The shared Escape / press-outside primitive. What it exists to guarantee is that one
 * Escape closes one surface — the one on top — where two hand-rolled listeners used to
 * close both.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test';
import { useRef } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useDismissable, type DismissableOptions } from '@/hooks/useDismissable';

function Surface({
  label,
  withOutside,
  ...opts
}: Omit<DismissableOptions, 'outside'> & { label: string; withOutside?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable({ ...opts, outside: withOutside ? ref : undefined });
  return <div ref={ref}>{label}</div>;
}

afterEach(() => cleanup());

describe('useDismissable', () => {
  it('sends Escape to the most recently opened surface only', () => {
    const below = mock(() => {});
    const above = mock(() => {});
    const { rerender } = render(
      <>
        <Surface label="below" onDismiss={below} />
        <Surface label="above" onDismiss={above} enabled={false} />
      </>,
    );
    rerender(
      <>
        <Surface label="below" onDismiss={below} />
        <Surface label="above" onDismiss={above} />
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();

    // Once the top one closes, the next Escape is the one below's.
    rerender(
      <>
        <Surface label="below" onDismiss={below} />
        <Surface label="above" onDismiss={above} enabled={false} />
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape that is finishing an IME composition alone', () => {
    const onDismiss = mock(() => {});
    render(<Surface label="s" onDismiss={onDismiss} />);

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on a press outside, not inside', () => {
    const onDismiss = mock(() => {});
    const { getByText } = render(<Surface label="inside" onDismiss={onDismiss} withOutside />);

    fireEvent.pointerDown(getByText('inside'));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('with escape off, stays out of the Escape stack entirely', () => {
    const below = mock(() => {});
    const above = mock(() => {});
    render(
      <>
        <Surface label="below" onDismiss={below} />
        <Surface label="above" onDismiss={above} escape={false} />
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(below).toHaveBeenCalledTimes(1);
    expect(above).not.toHaveBeenCalled();
  });
});
