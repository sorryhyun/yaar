/**
 * A JSON file kept in sync with an in-memory value: writes are debounced, atomic
 * (tmp file + rename), and serialized through one chain so two overlapping writes
 * can never interleave into a torn, unparsable file — the shape three callers
 * (a reload cache, a browser session store, a session logger's metadata) each
 * hand-wrote before this.
 */

import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

export interface DebouncedJsonFileOptions {
  /** Debounce window in milliseconds. */
  delayMs: number;
  /**
   * Reset the debounce window on every `schedule()` call (classic debounce: a
   * burst of calls only fires once the burst goes quiet) rather than firing at a
   * fixed delay from the first call after idle (coalescing: a burst fires once,
   * `delayMs` after it started). Default `false` — coalescing, which is what two
   * of the three original copies did.
   */
  resetOnSchedule?: boolean;
  /** Called when a write fails. Omit to swallow the error silently. */
  onError?: (err: unknown) => void;
}

export interface DebouncedJsonFile {
  /** Debounce a write of `snapshot()`'s value at schedule time. */
  schedule(): void;
  /**
   * Write now if a write is scheduled, then wait for it; otherwise just wait for
   * whatever is already in flight. Safe to call with nothing pending — it will
   * not perform a write nobody asked for, so a file that was never touched stays
   * that way.
   */
  flush(): Promise<void>;
}

/**
 * `snapshot` is called at write time, not at `schedule()` time, so whatever
 * changed in between is what lands on disk — there is no intermediate copy to go
 * stale, and a call to `schedule()` is just "make sure the current value gets
 * written soon", not "capture this value".
 */
export function createDebouncedJsonFile<T>(
  path: string,
  snapshot: () => T,
  options: DebouncedJsonFileOptions,
): DebouncedJsonFile {
  const { delayMs, resetOnSchedule = false, onError } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  function write(): Promise<void> {
    writing = writing.then(async () => {
      const tmp = `${path}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot(), null, 2), 'utf-8');
        await rename(tmp, path);
      } catch (err) {
        onError?.(err);
      }
    });
    return writing;
  }

  function schedule(): void {
    if (timer) {
      if (!resetOnSchedule) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, delayMs);
    // A pending write must never be what keeps a test run or a shutdown alive;
    // shutdown calls flush() instead of waiting out the timer.
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      await write();
      return;
    }
    await writing;
  }

  return { schedule, flush };
}
