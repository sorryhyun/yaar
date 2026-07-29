/**
 * Child names in a `yaar://storage/*` listing.
 *
 * The name is derived by slicing the parent prefix off each entry's path, and the
 * prefix was built as `${path}/` — so a URI that already ended in a slash produced
 * `mounts//`, one character too long, and every child came back missing its first
 * character ("mounts/toolresults" listed as "oolresults"). Nothing failed: the URI
 * stayed correct, so a click still worked, and only the *labels* were wrong. An app
 * (studio-3d) ended up carrying a workaround that re-derived names from the URI.
 *
 * Both spellings of the same directory must therefore produce the same names.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import { registerStorageHandlers } from '../handlers/storage.js';
import { storageWrite, storageDelete } from '../storage/storage-manager.js';

// `temp/` is the documented scratch prefix; STORAGE_DIR is fixed at import time.
const SCRATCH = `temp/__storage-list-test-${process.pid}`;

const registry = new ResourceRegistry();
registerStorageHandlers(registry);

afterAll(async () => {
  await storageDelete(SCRATCH);
});

/** The `name` of every child returned for a listing URI. */
async function namesOf(uri: string): Promise<string[]> {
  const result = await registry.execute('list', uri);
  const content = (result as { content?: { type?: string; name?: string }[] }).content ?? [];
  return content
    .filter((entry) => entry.type === 'resource_link')
    .map((entry) => entry.name ?? '')
    .sort();
}

describe('storage list child names', () => {
  it('names children the same with and without a trailing slash', async () => {
    await storageWrite(`${SCRATCH}/toolresults/a.txt`, 'a');
    await storageWrite(`${SCRATCH}/notes.txt`, 'n');

    const withoutSlash = await namesOf(`yaar://storage/${SCRATCH}`);
    const withSlash = await namesOf(`yaar://storage/${SCRATCH}/`);

    expect(withoutSlash).toEqual(['notes.txt', 'toolresults']);
    expect(withSlash).toEqual(withoutSlash);
  });

  it('keeps the first character of a nested directory name', async () => {
    await storageWrite(`${SCRATCH}/nested/toolresults/x.txt`, 'x');

    // The exact shape of the original report: the leading "t" used to be eaten.
    expect(await namesOf(`yaar://storage/${SCRATCH}/nested/`)).toEqual(['toolresults']);
  });
});
