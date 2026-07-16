/**
 * A JSON file under config/, read through a cache.
 *
 * `permissions.ts` and `mounts.ts` had each grown the same six steps by hand —
 * lazily resolve the config dir, read, parse, fall back to a default on any
 * failure, mkdir -p, write, refresh the cache — and a test hook to reset the
 * cache between runs. This is that, once.
 *
 * Deliberately NOT used by `settings.ts` / `shortcuts.ts`: those read through
 * `configRead` on every call and are meant to. `config/settings.json` is a file
 * the user edits by hand, and a cache would make those edits invisible until
 * restart. Same six steps, different contract.
 */

import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { getConfigDir } from './storage-manager.js';

export interface PersistedStore<T> {
  /** Read through the cache, falling back to a fresh default if absent or corrupt. */
  read(): Promise<T>;
  /** Persist and refresh the cache. */
  write(value: T): Promise<void>;
  /** read → mutate → write. The callback may mutate in place or return a replacement. */
  update(mutate: (current: T) => T | void): Promise<T>;
  /** The cached value without touching disk, or null if nothing is loaded yet. */
  peek(): T | null;
  /**
   * Override the cache. Pass null to reset.
   * @internal — only for use in test files.
   */
  _setForTest(value: T | null): void;
}

/**
 * @param filename  Name of the file under the config dir, e.g. `mounts.json`.
 * @param createDefault  Builds the value used when the file is missing or unparseable.
 *   A factory, not a value: the default is cached and handed to callers who mutate it
 *   in place, so a shared constant would be corrupted by the first write.
 */
export function createPersistedStore<T>(filename: string, createDefault: () => T): PersistedStore<T> {
  // Resolved per call, not at module load: the loopback harness points YAAR_CONFIG at a
  // temp dir after this module is imported.
  const path = (): string => join(getConfigDir(), filename);

  let cached: T | null = null;

  const read = async (): Promise<T> => {
    if (cached !== null) return cached;
    try {
      cached = JSON.parse(await Bun.file(path()).text()) as T;
    } catch {
      // Missing or corrupt — either way the caller gets a usable value, not a throw.
      cached = createDefault();
    }
    return cached;
  };

  const write = async (value: T): Promise<void> => {
    const filePath = path();
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, JSON.stringify(value, null, 2));
    cached = value;
  };

  return {
    read,
    write,
    async update(mutate) {
      const current = await read();
      const returned = mutate(current);
      const next = (returned === undefined ? current : returned) as T;
      await write(next);
      return next;
    },
    peek: () => cached,
    _setForTest: (value) => {
      cached = value;
    },
  };
}
