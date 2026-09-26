/**
 * `createDebouncedJsonFile` — debounce coalescing vs reset, flush semantics,
 * atomicity/serialization under a race, and the swallow-and-report error path.
 *
 * Three callers hand-wrote this sequence (a reload cache, a browser session
 * store, a session logger's metadata) before it moved here; the shape being
 * pinned is exactly what each of them depended on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDebouncedJsonFile } from '../json-file.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yaar-json-file-'));
  file = join(dir, 'nested', 'data.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

describe('createDebouncedJsonFile', () => {
  it('coalesces a burst of schedule() calls into one write (default: no reset)', async () => {
    let value = 'unset';
    let snapshotCalls = 0;
    const writer = createDebouncedJsonFile(
      file,
      () => {
        snapshotCalls++;
        return { value };
      },
      { delayMs: 40 },
    );

    for (let i = 0; i < 5; i++) {
      value = `call-${i}`;
      writer.schedule();
    }
    await Bun.sleep(80);

    expect(snapshotCalls).toBe(1);
    expect(await readJson(file)).toEqual({ value: 'call-4' });
  });

  it('resetOnSchedule extends the window on every call instead of coalescing to the first', async () => {
    let value = 'first';
    const writer = createDebouncedJsonFile(file, () => ({ value }), {
      delayMs: 40,
      resetOnSchedule: true,
    });

    writer.schedule();
    await Bun.sleep(25);
    value = 'second';
    writer.schedule(); // resets the 40ms window — no write yet at the 40ms mark from the first call
    await Bun.sleep(25);
    expect(await readFile(file, 'utf-8').catch(() => null)).toBeNull();

    await Bun.sleep(25); // now past 40ms since the reset
    expect(await readJson(file)).toEqual({ value: 'second' });
  });

  it('flush() writes a pending schedule immediately, without waiting out the debounce', async () => {
    const writer = createDebouncedJsonFile(file, () => ({ value: 'now' }), { delayMs: 5000 });
    writer.schedule();
    await writer.flush();
    expect(await readJson(file)).toEqual({ value: 'now' });
  });

  it('flush() with nothing pending does not create a file', async () => {
    const writer = createDebouncedJsonFile(file, () => ({ value: 'never' }), { delayMs: 20 });
    await writer.flush();
    expect(await readFile(file, 'utf-8').catch(() => null)).toBeNull();
  });

  it('a flush racing an in-flight write still lands the newer state last, atomically', async () => {
    let value = 'first';
    const writer = createDebouncedJsonFile(file, () => ({ value }), { delayMs: 1000 });

    writer.schedule();
    const first = writer.flush();
    value = 'second';
    writer.schedule();
    await Promise.all([first, writer.flush()]);

    expect(await readJson(file)).toEqual({ value: 'second' });
    // No leftover .tmp file, and nothing else written into the directory.
    expect(await readdir(join(dir, 'nested'))).toEqual(['data.json']);
  });

  it('creates the destination directory on demand', async () => {
    const writer = createDebouncedJsonFile(file, () => ({ ok: true }), { delayMs: 10 });
    writer.schedule();
    await writer.flush();
    expect(await readJson(file)).toEqual({ ok: true });
  });

  it('a write failure is swallowed and reported through onError, never thrown', async () => {
    // A regular file where a directory needs to be makes mkdir(dirname(path)) fail.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const blockedFile = join(blocker, 'data.json');

    const errors: unknown[] = [];
    const writer = createDebouncedJsonFile(blockedFile, () => ({ value: 1 }), {
      delayMs: 10,
      onError: (err) => errors.push(err),
    });

    writer.schedule();
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(await readFile(blockedFile, 'utf-8').catch(() => null)).toBeNull();
  });

  it('a write failure without onError is swallowed silently', async () => {
    const blocker = join(dir, 'blocker2');
    await writeFile(blocker, 'not a directory');
    const blockedFile = join(blocker, 'data.json');

    const writer = createDebouncedJsonFile(blockedFile, () => ({ value: 1 }), { delayMs: 10 });
    writer.schedule();
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it('reads snapshot() fresh at write time, not at schedule() time', async () => {
    const state = { value: 'a' };
    const writer = createDebouncedJsonFile(file, () => ({ ...state }), { delayMs: 5000 });
    writer.schedule();
    state.value = 'b'; // mutated after schedule(), before flush()
    await writer.flush();
    expect(await readJson(file)).toEqual({ value: 'b' });
  });
});
