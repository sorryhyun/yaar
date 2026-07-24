/**
 * Deleting an app's storage namespace root — `yaar://apps/{appId}/storage/`.
 *
 * This used to be refused with "Provide a file path to delete", which made one class
 * of namespace unreclaimable. Devtools previews run under a throwaway principal
 * (`preview--{projectId}`) that belongs to no installed app: nothing lists it, no GC
 * sweeps it, and the single caller that ever tried to reclaim it — `deleteProject`'s
 * cleanup — passed exactly this URI and swallowed the error. Twenty-six orphaned
 * namespaces later, the guard was the bug.
 *
 * What is pinned here: the root delete removes the subtree *and* the directory, a
 * nested path still deletes just that path, and traversal out of the namespace is
 * still refused (the root case must not have widened the parse).
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { deleteStorage } from '../handlers/apps/storage-resource.js';
import { resolvePath, storageWrite, storageDelete } from '../storage/storage-manager.js';

// A namespace no installed app owns — the same shape as a devtools preview identity.
const APP_ID = `preview--__ns-delete-test-${process.pid}`;

/** deleteStorage only reads `sourceUri`; the rest of ResolvedUri is inert here. */
function uri(path: string) {
  const sourceUri = `yaar://apps/${APP_ID}/storage/${path}`;
  const resolved = resolvePath(`apps/${APP_ID}/${path}`);
  return {
    kind: 'storage' as const,
    absolutePath: resolved?.absolutePath ?? '',
    readOnly: false,
    sourceUri,
    apiPath: `/api/storage/apps/${APP_ID}/${path}`,
  };
}

function nsDir(): string {
  return resolvePath(`apps/${APP_ID}/`)!.absolutePath;
}

afterAll(async () => {
  await storageDelete(`apps/${APP_ID}`);
});

describe('deleteStorage on an app storage namespace', () => {
  it('deletes the whole namespace, directory included, for an empty path', async () => {
    await storageWrite(`apps/${APP_ID}/draft.json`, '{"a":1}');
    await storageWrite(`apps/${APP_ID}/projects/1/src/main.ts`, 'export {};');
    expect(existsSync(nsDir())).toBe(true);

    const result = await deleteStorage(uri(''));
    expect(result?.isError).toBeUndefined();
    // The directory itself goes too — an empty `storage/apps/{id}/` left behind is
    // still an orphan nothing else will ever notice.
    expect(existsSync(nsDir())).toBe(false);
  });

  it('reports failure when the namespace does not exist', async () => {
    const result = await deleteStorage(uri(''));
    expect(result?.isError).toBe(true);
  });

  it('still deletes a single file without touching its siblings', async () => {
    await storageWrite(`apps/${APP_ID}/keep.json`, '{"keep":true}');
    await storageWrite(`apps/${APP_ID}/drop.json`, '{"drop":true}');

    const result = await deleteStorage(uri('drop.json'));
    expect(result?.isError).toBeUndefined();
    expect(existsSync(resolvePath(`apps/${APP_ID}/drop.json`)!.absolutePath)).toBe(false);
    expect(existsSync(resolvePath(`apps/${APP_ID}/keep.json`)!.absolutePath)).toBe(true);
  });

  it('deletes a nested directory recursively', async () => {
    await storageWrite(`apps/${APP_ID}/projects/1/src/main.ts`, 'export {};');
    const result = await deleteStorage(uri('projects/'));
    expect(result?.isError).toBeUndefined();
    expect(existsSync(resolvePath(`apps/${APP_ID}/projects`)!.absolutePath)).toBe(false);
  });

  it('refuses traversal out of the namespace', async () => {
    const escape = {
      kind: 'storage' as const,
      absolutePath: '',
      readOnly: false,
      sourceUri: `yaar://apps/${APP_ID}/storage/../../config/credentials.json`,
      apiPath: '',
    };
    // A traversing URI is not a storage URI at all — the composite handler falls
    // through to the app itself rather than deleting anything.
    expect(await deleteStorage(escape)).toBeNull();
  });
});
