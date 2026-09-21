/**
 * DrawingSlice — the overlay's save/clear/consume/pencil-mode state. `consumeDrawing`
 * is a one-shot read: whatever asks for the last stroke gets it exactly once, then null,
 * so a second consumer (or a retry) does not replay a drawing that was already sent.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '@/store';

describe('drawing slice', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      hasDrawing: false,
      canvasDataUrl: null,
      pencilMode: false,
    });
  });

  it('starts with no drawing and pencil mode off', () => {
    const state = useDesktopStore.getState();
    expect(state.hasDrawing).toBe(false);
    expect(state.canvasDataUrl).toBeNull();
    expect(state.pencilMode).toBe(false);
  });

  it('saveDrawing records the data URL and flags hasDrawing', () => {
    useDesktopStore.getState().saveDrawing('data:image/png;base64,abc');

    const state = useDesktopStore.getState();
    expect(state.hasDrawing).toBe(true);
    expect(state.canvasDataUrl).toBe('data:image/png;base64,abc');
  });

  it('clearDrawing wipes both the flag and the data', () => {
    useDesktopStore.getState().saveDrawing('data:image/png;base64,abc');
    useDesktopStore.getState().clearDrawing();

    const state = useDesktopStore.getState();
    expect(state.hasDrawing).toBe(false);
    expect(state.canvasDataUrl).toBeNull();
  });

  it('consumeDrawing returns the saved data once, then null on a second call', () => {
    useDesktopStore.getState().saveDrawing('data:image/png;base64,xyz');

    const first = useDesktopStore.getState().consumeDrawing();
    expect(first).toBe('data:image/png;base64,xyz');

    const second = useDesktopStore.getState().consumeDrawing();
    expect(second).toBeNull();

    // And it left the state cleared behind it, matching clearDrawing.
    const state = useDesktopStore.getState();
    expect(state.hasDrawing).toBe(false);
    expect(state.canvasDataUrl).toBeNull();
  });

  it('consumeDrawing on an empty slice returns null without touching state', () => {
    const result = useDesktopStore.getState().consumeDrawing();
    expect(result).toBeNull();
    expect(useDesktopStore.getState().hasDrawing).toBe(false);
  });

  it('togglePencilMode flips back and forth', () => {
    expect(useDesktopStore.getState().pencilMode).toBe(false);
    useDesktopStore.getState().togglePencilMode();
    expect(useDesktopStore.getState().pencilMode).toBe(true);
    useDesktopStore.getState().togglePencilMode();
    expect(useDesktopStore.getState().pencilMode).toBe(false);
  });

  it('setPencilMode sets an explicit value regardless of the current one', () => {
    useDesktopStore.getState().setPencilMode(true);
    expect(useDesktopStore.getState().pencilMode).toBe(true);
    useDesktopStore.getState().setPencilMode(true);
    expect(useDesktopStore.getState().pencilMode).toBe(true);
    useDesktopStore.getState().setPencilMode(false);
    expect(useDesktopStore.getState().pencilMode).toBe(false);
  });
});
