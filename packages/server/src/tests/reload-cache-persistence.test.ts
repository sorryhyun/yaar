/**
 * The reload cache's disk write: atomic, serialized, and flushable at shutdown.
 *
 * It used to be a debounced plain overwrite with no flush — the last ~500ms of
 * recordings died with the process, and a torn file parsed as corrupt, which `load()`
 * reads as "no cache" and silently starts over.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReloadCache } from '../reload/cache.js';
import type { Fingerprint } from '../reload/types.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reload-cache-'));
  file = join(dir, 'nested', 'session.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fingerprint(n: number): Fingerprint {
  return {
    triggerType: 'monitor',
    ngrams: [`word${n}`],
    contentHash: `content-${n}`,
    windowStateHash: 'windows',
  };
}

describe('ReloadCache persistence', () => {
  it('flush() writes a pending save immediately, without waiting out the debounce', async () => {
    const cache = new ReloadCache(file);
    cache.record(fingerprint(1), [], 'first');
    await cache.flush();

    expect(existsSync(file)).toBe(true);
    const reloaded = new ReloadCache(file);
    await reloaded.load();
    expect(reloaded.listEntries().map((e) => e.label)).toEqual(['first']);
  });

  it('writes the latest state and leaves no temp file behind', async () => {
    const cache = new ReloadCache(file);
    for (let i = 0; i < 5; i++) cache.record(fingerprint(i), [], `entry-${i}`);
    await cache.flush();

    expect(await readdir(join(dir, 'nested'))).toEqual(['session.json']);
    const reloaded = new ReloadCache(file);
    await reloaded.load();
    expect(reloaded.listEntries()).toHaveLength(5);
  });

  it('flush() with nothing pending does not create a file', async () => {
    const cache = new ReloadCache(file);
    await cache.load();
    await cache.flush();
    expect(existsSync(file)).toBe(false);
  });

  it('a flush racing an in-flight write still lands the newer state last', async () => {
    const cache = new ReloadCache(file);
    cache.record(fingerprint(1), [], 'first');
    const first = cache.flush();
    cache.record(fingerprint(2), [], 'second');
    await Promise.all([first, cache.flush()]);

    const reloaded = new ReloadCache(file);
    await reloaded.load();
    expect(reloaded.listEntries().map((e) => e.label)).toEqual(['first', 'second']);
  });
});
