/**
 * A tab on an older build than the server holds fails its next lazy import. That failure
 * has to be told apart from an ordinary one (a diagram that will not parse), and offered
 * as a reload once — not once per failed import.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '@/store';
import { announceStaleBuild, isChunkLoadError } from '@/lib/staleBuild';
import { runLocalToastAction } from '@/lib/localToastActions';

describe('isChunkLoadError', () => {
  it('recognises each engine’s failed dynamic import', () => {
    for (const message of [
      // Chrome
      'Failed to fetch dynamically imported module: http://localhost:8000/chunk-x4h10bek.js',
      // Firefox
      'error loading dynamically imported module: http://localhost:8000/chunk-x4h10bek.js',
      // Safari
      'Importing a module script failed.',
      // An HTML page served under the chunk's URL
      "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of 'text/html'.",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
  });

  it('accepts a bare string reason', () => {
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isChunkLoadError(new Error('Parse error on line 2'))).toBe(false);
    expect(isChunkLoadError(new Error('diagram source is empty'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(false);
  });
});

describe('announceStaleBuild', () => {
  beforeEach(() => {
    useDesktopStore.setState({ toasts: {} });
  });

  it('raises one persistent toast with a local Reload action, however often it is called', () => {
    announceStaleBuild();
    announceStaleBuild();
    announceStaleBuild();

    const toasts = Object.values(useDesktopStore.getState().toasts);
    expect(toasts).toHaveLength(1);
    const [toast] = toasts;
    expect(toast.duration).toBe(0);
    expect(toast.action?.eventId).toBeDefined();
    // The button is wired locally — the server minted no event for it.
    const reload = window.location.reload;
    let reloaded = 0;
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: () => {
        reloaded++;
      },
    });
    try {
      expect(runLocalToastAction(toast.action!.eventId)).toBe(true);
      expect(reloaded).toBe(1);
    } finally {
      Object.defineProperty(window.location, 'reload', { configurable: true, value: reload });
    }
  });
});
