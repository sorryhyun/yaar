/**
 * `lines`/`pattern` on a read of `yaar://apps/{appId}/storage/...`.
 *
 * The door took `ReadOptions` for `missingOk` alone and dropped the line filter, so a
 * pattern read of an app's file came back whole. Pinned both ways: a filtered read is
 * filtered and says so (`readFiltered`, which keeps the registry's "ignored" note off it),
 * and an unfiltered read is still the stored text byte for byte — it is also what an
 * app's own storage read gets, and a line-numbered file would break every one of them.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { readStorage } from '../handlers/apps/storage-resource.js';
import { resolvePath, storageWrite, storageDelete } from '../storage/storage-manager.js';
import type { VerbResult } from '../handlers/uri-registry.js';

const APP_ID = `preview--__read-filter-test-${process.pid}`;
const BODY = 'alpha\nbeta\ngamma\nbeta again';

/** readStorage only reads `sourceUri`; the rest of ResolvedUri is inert here. */
function uri(path: string) {
  const resolved = resolvePath(`apps/${APP_ID}/${path}`);
  return {
    kind: 'storage' as const,
    absolutePath: resolved?.absolutePath ?? '',
    readOnly: false,
    sourceUri: `yaar://apps/${APP_ID}/storage/${path}`,
    apiPath: `/api/storage/apps/${APP_ID}/${path}`,
  };
}

function resourceText(result: VerbResult | null): string {
  const block = result?.content[0];
  if (block?.type !== 'resource' || !('text' in block.resource)) {
    throw new Error(`no embedded resource in result: ${JSON.stringify(result?.content)}`);
  }
  return block.resource.text;
}

afterAll(async () => {
  await storageDelete(`apps/${APP_ID}`);
});

describe('readStorage with a line filter', () => {
  it('returns only the matching lines, numbered, and marks the result filtered', async () => {
    await storageWrite(`apps/${APP_ID}/notes.txt`, BODY);

    const result = await readStorage(uri('notes.txt'), { pattern: 'beta' });

    expect(result?.readFiltered).toBe(true);
    const text = resourceText(result);
    expect(text).toContain('2│beta');
    expect(text).toContain('4│beta again');
    expect(text).not.toContain('alpha');
  });

  it('leaves an unfiltered read as the stored text, byte for byte', async () => {
    await storageWrite(`apps/${APP_ID}/notes.txt`, BODY);

    const result = await readStorage(uri('notes.txt'));

    expect(resourceText(result)).toBe(BODY);
    expect(result?.readFiltered).toBeUndefined();
  });
});
