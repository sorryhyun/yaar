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
 *  2. the gate — `permissionsAllow`, the same rule the iframe door asks, including what
 *     a declared `yaar://storage/` covers. It covers the whole tree, app storage
 *     included: `storage/apps/{id}/` is a plain subtree of the root, and a prefix that
 *     quietly excluded it was a prefix no reader could predict. What keeps that from
 *     being a hole is `coversForeignAppStorage`, which decides who may *hold* the grant
 *     — pinned below, and applied to every non-bundled manifest by `discovery.ts`.
 */
import { describe, it, expect } from 'bun:test';
import {
  namesSharedStorage,
  sharedStoragePath,
  sharedStorageUri,
  authorizeSharedStorage,
} from '../mcp/app-agent/shared-storage.js';
import {
  capForeignAppStorage,
  coversForeignAppStorage,
  permissionsAllow,
  type PermissionEntry,
} from '../http/access.js';

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

  it('lets the full root reach app storage, in either spelling', () => {
    // `yaar://storage/apps/{id}/…` and `yaar://apps/{id}/storage/…` are the same file, so
    // the two must answer alike — a gate that admitted one and refused the other is the
    // seam the file manager fell into: it could list `storage/apps` and open nothing
    // under it. Who is allowed to *hold* this grant is the next test.
    for (const uri of [
      'yaar://storage/apps/vault/secrets.json',
      'yaar://apps/vault/storage/secrets.json',
      'yaar://storage/apps/github/x.json',
      'yaar://apps/github/storage/x.json',
    ]) {
      expect(permissionsAllow(FULL, 'github', uri, 'read')).toBe(true);
    }
  });

  it('is a grant only an app shipped with the repo may declare', () => {
    // The containment `canonicalStorageUri` used to do by rewriting the URI. Stated over
    // the whole class, so naming one app outright is refused too — the old rewrite only
    // ever caught the broad prefix and let `yaar://storage/apps/vault/` straight through.
    for (const entry of [
      'yaar://storage/',
      'yaar://storage/apps/',
      'yaar://storage/apps/vault/',
      'yaar://apps/vault/storage/',
      'yaar://storage/apps/notes/../vault/',
    ]) {
      expect(coversForeignAppStorage(entry, 'notes')).toBe(true);
    }

    // Its own subtree in either dialect, a narrowed shared prefix, and the bare root
    // listing (no trailing slash — it names the directory, not everything under it).
    for (const entry of [
      'yaar://apps/self/storage/',
      'yaar://apps/notes/storage/',
      'yaar://storage/apps/notes/',
      'yaar://storage/media/',
      'yaar://storage',
      'yaar://windows/',
    ]) {
      expect(coversForeignAppStorage(entry, 'notes')).toBe(false);
    }
  });

  it('reads the verbs off an object entry when deciding it is foreign', () => {
    // `{ uri, verbs }` is the other spelling of an entry, and a check that only handled
    // the string form would let the object form carry the same grant through unnarrowed.
    expect(coversForeignAppStorage({ uri: 'yaar://storage/', verbs: ['read'] }, 'notes')).toBe(
      true,
    );
    expect(coversForeignAppStorage({ uri: 'yaar://apps/self/storage/' }, 'notes')).toBe(false);
  });

  it('caps that grant for an installed app instead of taking it away', () => {
    // `yaar://storage/` is one entry doing two jobs. An installed app never gets the
    // reach into `apps/`; it keeps the shared tree, which is what it always actually had.
    // Dropping the entry outright would have been a silent regression for every installed
    // app that writes to `media/`.
    const { capped, changed } = capForeignAppStorage(
      ['yaar://storage/', 'yaar://windows/'],
      'github',
    );
    expect(changed).toBe(1);
    expect(capped).toEqual([{ uri: 'yaar://storage/', sharedOnly: true }, 'yaar://windows/']);

    for (const uri of ['yaar://storage/media/shot.png', 'yaar://storage/reports/x.md']) {
      expect(permissionsAllow(capped, 'github', uri, 'read')).toBe(true);
    }
    // Its own storage is still its own, in either spelling.
    expect(permissionsAllow(capped, 'github', 'yaar://storage/apps/github/x.json', 'read')).toBe(
      true,
    );
    expect(permissionsAllow(capped, 'github', 'yaar://apps/github/storage/x.json', 'read')).toBe(
      true,
    );
    // And the reach the cap exists to remove is gone, in either spelling.
    expect(permissionsAllow(capped, 'github', 'yaar://storage/apps/vault/x.json', 'read')).toBe(
      false,
    );
    expect(permissionsAllow(capped, 'github', 'yaar://apps/vault/storage/x.json', 'read')).toBe(
      false,
    );
  });

  it('leaves nothing behind when the entry named only foreign storage', () => {
    // The mark is a ceiling, so an entry with nothing under the ceiling grants nothing.
    const { capped } = capForeignAppStorage(['yaar://storage/apps/vault/'], 'github');
    expect(permissionsAllow(capped, 'github', 'yaar://storage/apps/vault/x.json', 'read')).toBe(
      false,
    );
  });

  it('lets a grant over the app’s whole namespace still reach its storage', () => {
    // `yaar://apps/self/` covers `storage/`, `db/` and `agents/` alike in the dialect it
    // is written in — but the storage half canonicalizes into the flat tree, out of that
    // prefix entirely. `grantEntries` carries the flat spelling alongside it.
    const whole = ['yaar://apps/self/'];
    expect(permissionsAllow(whole, 'notes', 'yaar://apps/notes/storage/todo.json', 'read')).toBe(
      true,
    );
    expect(permissionsAllow(whole, 'notes', 'yaar://storage/apps/notes/todo.json', 'read')).toBe(
      true,
    );
    expect(permissionsAllow(whole, 'notes', 'yaar://apps/notes/db/main', 'read')).toBe(true);
    // Still one app's namespace, not the registry's.
    expect(permissionsAllow(whole, 'notes', 'yaar://apps/vault/storage/x.json', 'read')).toBe(
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
