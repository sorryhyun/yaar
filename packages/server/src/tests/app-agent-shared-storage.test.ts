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
  appNamespaceStorage,
  expandStorageShortcut,
  namesCommons,
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

describe('the relative shortcuts', () => {
  it('sends shared/… to the commons — the tree every prompt calls "shared/"', () => {
    // Before: a silent shadow folder at storage/apps/{id}/shared/. Now: the commons URI,
    // which the shared branch handles and permissionsAllow grants to every app.
    expect(expandStorageShortcut('shared/anima/dragon.png')).toBe(
      'yaar://storage/shared/anima/dragon.png',
    );
    expect(expandStorageShortcut('shared')).toBe('yaar://storage/shared');
    expect(expandStorageShortcut('/shared/x')).toBe('yaar://storage/shared/x');
    expect(namesSharedStorage(expandStorageShortcut('shared/x'))).toBe(true);
  });

  it('never reaches past the commons — the gated tree is still URI-only', () => {
    // A relative spelling must not become a way to name yaar://storage/reports/.
    expect(expandStorageShortcut('reports/x.md')).toBe('reports/x.md');
    expect(expandStorageShortcut('sharedx/y')).toBe('sharedx/y');
    expect(expandStorageShortcut('a/shared/x')).toBe('a/shared/x');
  });

  it('strips app/… to the own tree', () => {
    expect(expandStorageShortcut('app/notes.json')).toBe('notes.json');
    expect(expandStorageShortcut('app')).toBe('');
    expect(expandStorageShortcut('apps/x')).toBe('apps/x');
  });

  it('leaves a traversal for the path guard to refuse, not for the shortcut to hide', () => {
    expect(sharedStoragePath(expandStorageShortcut('shared/../config'))).toBeNull();
    expect(expandStorageShortcut('app/../x')).toBe('../x');
  });
});

describe('the commons — the only shared path an override may take', () => {
  it('is the shared/ subtree, either spelling once expanded', () => {
    expect(namesCommons('yaar://storage/shared')).toBe(true);
    expect(namesCommons('yaar://storage/shared/word-excel/report.docx')).toBe(true);
    expect(namesCommons(expandStorageShortcut('shared/x.md'))).toBe(true);
  });

  it('excludes everything the app.json gate guards', () => {
    expect(namesCommons('yaar://storage')).toBe(false);
    expect(namesCommons('yaar://storage/reports/x.md')).toBe(false);
    expect(namesCommons('yaar://storage/sharedx/y')).toBe(false);
    expect(namesCommons('yaar://storage/apps/notes/x')).toBe(false);
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
      'yaar://storage/shared/',
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
    // app that writes to `shared/`.
    const { capped, changed } = capForeignAppStorage(
      ['yaar://storage/', 'yaar://windows/'],
      'github',
    );
    expect(changed).toBe(1);
    expect(capped).toEqual([{ uri: 'yaar://storage/', sharedOnly: true }, 'yaar://windows/']);

    for (const uri of ['yaar://storage/shared/shot.png', 'yaar://storage/reports/x.md']) {
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
    // Narrowed to one folder that is *not* the commons — `yaar://storage/shared/` would
    // prove nothing here, since every app holds it whether it declares it or not.
    const reports = ['yaar://storage/reports/'];
    expect(permissionsAllow(reports, 'devtools', 'yaar://storage/reports/x.md', 'read')).toBe(true);
    expect(permissionsAllow(reports, 'devtools', 'yaar://storage/files/tax.pdf', 'read')).toBe(
      false,
    );
  });

  it('gives every app the commons, declared or not', () => {
    // The grant that is not a grant: `yaar://storage/shared/` is granted for being an
    // app, so an empty permission list reaches it and the rest of the tree stays shut.
    for (const verb of ['read', 'list', 'invoke', 'delete'] as const) {
      expect(permissionsAllow([], 'anima', 'yaar://storage/shared/anima/x.png', verb)).toBe(true);
    }
    expect(permissionsAllow([], 'anima', 'yaar://storage/files/tax.pdf', 'read')).toBe(false);
    expect(permissionsAllow([], 'anima', 'yaar://storage/apps/vault/keys', 'read')).toBe(false);
    // No app, nothing to grant to — a plain iframe token carries no appId.
    expect(permissionsAllow([], undefined, 'yaar://storage/shared/anima/x.png', 'read')).toBe(
      false,
    );
    // A traversing spelling names no resource, commons or not.
    expect(permissionsAllow([], 'anima', 'yaar://storage/shared/../files/tax.pdf', 'read')).toBe(
      false,
    );
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

/**
 * The third spelling — the one the door *emits*.
 *
 * Every app-scoped result names `yaar://apps/{id}/storage/{path}` (`resolvedStorageUri`,
 * and each `(resolved to …)`), and that spelling used to reach neither storage branch: it
 * is not `yaar://storage/…` and not a relative `storage/` path, so it fell through to the
 * app protocol and failed as an unknown *state key*. A model that reads a listing and asks
 * for one of its entries by the name it was just shown is doing exactly what the reported
 * URI invites, so the door has to accept what it prints.
 */
describe('reading back the URI the door printed', () => {
  it('resolves the app’s own tree to the relative path, in both dialects', () => {
    // Naming your own id and writing `self` are the same request — `resolveSelf` runs
    // before the flattening, exactly as it does in `permissionsAllow`.
    for (const arg of [
      'yaar://apps/memo/storage/reports/x.md',
      'yaar://apps/self/storage/reports/x.md',
    ]) {
      expect(appNamespaceStorage(arg, 'memo')).toEqual({ kind: 'own', path: 'reports/x.md' });
    }
  });

  it('reads the storage root itself as the empty path, not as a miss', () => {
    expect(appNamespaceStorage('yaar://apps/memo/storage', 'memo')).toEqual({
      kind: 'own',
      path: '',
    });
    expect(appNamespaceStorage('yaar://apps/self/storage', 'memo')).toEqual({
      kind: 'own',
      path: '',
    });
  });

  it('hands another app’s tree back in the coordinates its grant is written in', () => {
    // Flat, not namespaced: `authorizeSharedStorage` asks `permissionsAllow`, which
    // canonicalizes to this form — so returning it is what makes the two dialects
    // impossible to play against each other.
    expect(appNamespaceStorage('yaar://apps/vault/storage/secrets.json', 'memo')).toEqual({
      kind: 'foreign',
      uri: 'yaar://storage/apps/vault/secrets.json',
    });
  });

  it('refuses a traversing path instead of resolving it', () => {
    expect(appNamespaceStorage('yaar://apps/memo/storage/../../etc', 'memo')).toEqual({
      kind: 'invalid',
    });
  });

  it('leaves every other app sub-path to the app protocol', () => {
    // `null` means "not a storage argument" — the caller carries on to `handleAppQuery`,
    // which is where these were always going.
    expect(appNamespaceStorage('yaar://apps/memo/protocol', 'memo')).toBeNull();
    expect(appNamespaceStorage('yaar://apps/memo/db/notes', 'memo')).toBeNull();
    expect(appNamespaceStorage('yaar://apps/memo', 'memo')).toBeNull();
    // Not this dialect at all — the other two branches own these.
    expect(appNamespaceStorage('yaar://storage/shared/x', 'memo')).toBeNull();
    expect(appNamespaceStorage('storage/x', 'memo')).toBeNull();
  });

  it('agrees with the gate about which tree a URI names', async () => {
    // The point of returning the flat spelling: whatever `appNamespaceStorage` calls
    // foreign must be the same string `permissionsAllow` would judge, or one dialect
    // becomes a way around the other.
    const target = appNamespaceStorage('yaar://apps/vault/storage/secrets.json', 'memo');
    expect(target?.kind).toBe('foreign');
    if (target?.kind !== 'foreign') throw new Error('unreachable');
    expect(permissionsAllow(['yaar://storage/'], 'memo', target.uri, 'read')).toBe(true);
    expect(permissionsAllow([], 'memo', target.uri, 'read')).toBe(false);
  });
});
