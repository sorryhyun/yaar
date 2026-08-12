/**
 * `storageRead` on a directory: the discriminant, not just the sentence.
 *
 * The error string already said "is a directory. Use list instead.", but the app agent's
 * `query` door had no way to act on it — matching on prose is how a caller ends up
 * treating a renamed message as a missing file. So `query` dead-ended on every
 * subdirectory: it listed the storage root and nothing below it, and the advice it
 * returned named `list`, which is not a verb that door has. Descending meant knowing to
 * switch to `command("storage:list")`, which is the "cannot navigate storage" report
 * this flag exists to close.
 *
 * `isDirectory` is the mirror of `StorageListResult.notFound` — same shape, same reason:
 * a caller that wants to recover from the wrong-shape answer can tell it apart from the
 * nothing-there answer without reading English.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { storageRead, storageWrite, storageList } from '../storage/storage-manager.js';

const DIR = 'read-directory-fixture';
const FILE = `${DIR}/nested/leaf.txt`;

describe('storageRead on a directory', () => {
  beforeAll(async () => {
    // Writing the leaf creates both `DIR` and `DIR/nested`.
    await storageWrite(FILE, 'leaf');
  });

  it('flags a directory rather than only saying so in prose', async () => {
    const result = await storageRead(DIR);

    expect(result.success).toBe(false);
    expect(result.isDirectory).toBe(true);
    // The sentence stays — it is what a human reader sees.
    expect(result.error).toContain('is a directory');
  });

  it('flags a nested directory the same way', async () => {
    const result = await storageRead(`${DIR}/nested`);

    expect(result.success).toBe(false);
    expect(result.isDirectory).toBe(true);
  });

  it('leaves a missing path unflagged, so the two failures stay distinguishable', async () => {
    const result = await storageRead(`${DIR}/no-such-file.txt`);

    expect(result.success).toBe(false);
    expect(result.isDirectory).toBeUndefined();
    expect(result.error).toContain('not found');
  });

  it('does not flag a file it can read', async () => {
    const result = await storageRead(FILE);

    expect(result.success).toBe(true);
    expect(result.isDirectory).toBeUndefined();
    expect(result.content).toBe('leaf');
  });

  it('names a path the recovery can hand straight to storageList', async () => {
    // The whole point of the flag: read says "wrong shape", list answers the same path.
    expect((await storageRead(DIR)).isDirectory).toBe(true);

    const listed = await storageList(DIR);
    expect(listed.success).toBe(true);
    expect(listed.entries?.map((e) => e.path)).toContain(`${DIR}/nested`);
  });
});
