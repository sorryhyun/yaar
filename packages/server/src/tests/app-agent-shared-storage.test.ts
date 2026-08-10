/**
 * The app agent's door onto the shared storage tree.
 *
 * `query`/`command` rewrote every `storage/...` argument to the caller's own app-scoped
 * tree *before* consulting any permission, so an app declaring `yaar://storage/` — the
 * full root — had that grant enforced for its iframe code and unreachable from its
 * agent, whose four tools are its entire surface. Two app agents hit it independently:
 * told to read a file at the shared root, they were redirected to their own empty
 * storage and answered "file not found".
 *
 * These tests pin the two halves of the fix that can go wrong quietly:
 *
 *  1. the spelling — a `yaar://storage/...` URI names the shared tree and a relative
 *     path still names the app's own, with no argument that could mean both;
 *  2. the gate — `permissionsAllow`, the same rule the iframe door asks, and in
 *     particular that a declared `yaar://storage/` is *not* a permission for
 *     `yaar://storage/apps/{other}/`. That prefix reads as if it covered every other
 *     app's private storage, and only `canonicalStorageUri` stops it from doing so.
 */
import { describe, it, expect } from 'bun:test';
import {
  namesSharedStorage,
  sharedStoragePath,
  sharedStorageUri,
  authorizeSharedStorage,
} from '../mcp/app-agent/shared-storage.js';
import { permissionsAllow, type PermissionEntry } from '../http/access.js';

describe('naming the shared tree', () => {
  it('recognizes the URI spelling, root included', () => {
    expect(namesSharedStorage('yaar://storage')).toBe(true);
    expect(namesSharedStorage('yaar://storage/')).toBe(true);
    expect(namesSharedStorage('yaar://storage/reports/x.md')).toBe(true);
  });

  it('leaves every relative path to the app-scoped door', () => {
    // The scheme is the whole discriminator: adding this branch must not change what a
    // single existing `storage/...` argument means.
    expect(namesSharedStorage('storage')).toBe(false);
    expect(namesSharedStorage('storage/x.md')).toBe(false);
    expect(namesSharedStorage('')).toBe(false);
    // A different authority is not this door's business.
    expect(namesSharedStorage('yaar://apps/notes/storage/x.md')).toBe(false);
    expect(namesSharedStorage('yaar://storagex/x.md')).toBe(false);
  });

  it('maps a URI to the storage-root-relative path and back', () => {
    expect(sharedStoragePath('yaar://storage/reports/x.md')).toBe('reports/x.md');
    expect(sharedStoragePath('yaar://storage/reports/')).toBe('reports');
    expect(sharedStoragePath('yaar://storage')).toBe('');
    expect(sharedStoragePath('yaar://storage/')).toBe('');

    expect(sharedStorageUri('reports/x.md')).toBe('yaar://storage/reports/x.md');
    expect(sharedStorageUri('')).toBe('yaar://storage');
  });

  it('refuses a traversing path — it would be checked as one URI and read as another', () => {
    expect(sharedStoragePath('yaar://storage/../config/credentials.json')).toBeNull();
    expect(sharedStoragePath('yaar://storage/reports/../../x')).toBeNull();
  });
});

describe('the gate the door asks', () => {
  const FULL = ['yaar://storage/'];

  it('admits the shared root for an app that declared it', () => {
    expect(permissionsAllow(FULL, 'github', 'yaar://storage/report.md', 'read')).toBe(true);
    expect(permissionsAllow(FULL, 'github', 'yaar://storage', 'list')).toBe(true);
    expect(permissionsAllow(FULL, 'github', 'yaar://storage/report.md', 'invoke')).toBe(true);
    expect(permissionsAllow(FULL, 'github', 'yaar://storage/report.md', 'delete')).toBe(true);
  });

  it('refuses an app that declared nothing', () => {
    expect(permissionsAllow([], 'notes', 'yaar://storage/report.md', 'read')).toBe(false);
  });

  it('never lets the full root reach another app’s private storage', () => {
    // `yaar://storage/apps/{id}/…` and `yaar://apps/{id}/storage/…` are the same file, and
    // only the second spelling is what a permission is written against. Without the
    // rewrite this is plain prefix matching and `yaar://storage/` reads every app's
    // credentials, databases, and project sources.
    expect(permissionsAllow(FULL, 'github', 'yaar://storage/apps/vault/secrets.json', 'read')).toBe(
      false,
    );
    expect(permissionsAllow(FULL, 'github', 'yaar://apps/vault/storage/secrets.json', 'read')).toBe(
      false,
    );
    // Including its own — a relative `storage/x` is how an app reads that tree, and it
    // needs no permission, so the flat spelling gaining one would be a second door.
    expect(permissionsAllow(FULL, 'github', 'yaar://storage/apps/github/x.json', 'read')).toBe(
      false,
    );
  });

  it('honours a narrowed prefix', () => {
    const media = ['yaar://storage/media/'];
    expect(permissionsAllow(media, 'devtools', 'yaar://storage/media/shot.png', 'read')).toBe(true);
    expect(permissionsAllow(media, 'devtools', 'yaar://storage/reports/x.md', 'read')).toBe(false);
  });

  it('honours a verb-restricted entry — look, do not write', () => {
    const readOnly: PermissionEntry[] = [{ uri: 'yaar://storage/', verbs: ['read', 'list'] }];
    expect(permissionsAllow(readOnly, 'github', 'yaar://storage/x.md', 'read')).toBe(true);
    expect(permissionsAllow(readOnly, 'github', 'yaar://storage', 'list')).toBe(true);
    // `storage:write` is charged as `invoke` and `storage:delete` as `delete`, the same
    // verbs the verbs door charges for the same work.
    expect(permissionsAllow(readOnly, 'github', 'yaar://storage/x.md', 'invoke')).toBe(false);
    expect(permissionsAllow(readOnly, 'github', 'yaar://storage/x.md', 'delete')).toBe(false);
  });
});

describe('the refusal', () => {
  it('names the missing permission and the other tree, rather than 404-ing', async () => {
    // The reported failure was an agent that could not tell "my permission has no route
    // here" from "the file is not there". An app with no manifest on disk is the
    // no-permission case; what matters is that the sentence says which is which.
    const denied = await authorizeSharedStorage(
      'no-such-app',
      'devtools-friction-report.md',
      'read',
    );
    expect(denied).toContain('not permitted: read yaar://storage/devtools-friction-report.md');
    expect(denied).toContain('permissions');
    expect(denied).toContain('storage/devtools-friction-report.md');
  });
});
