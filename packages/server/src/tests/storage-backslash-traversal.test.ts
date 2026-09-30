/**
 * A backslash is a path separator at the gate, because it is one on disk.
 *
 * `resolvePath` turns `\` into `/` before it touches the filesystem. The gate used to
 * split on `/` alone, so `shared/..\apps\vault\secret.txt` read as a file inside the
 * commons — which every app holds — and opened another app's private storage. The same
 * mismatch let `apps\vault\x` slip under a `sharedOnly` grant, which is only capped for
 * paths that parse as another app's storage.
 */
import { describe, it, expect } from 'bun:test';
import { permissionsAllow, storageUriForPath } from '../http/access.js';
import { canonicalStorageUri } from '../http/uri-match.js';
import { parseContentPath } from '../lib/yaar-uri-server.js';

describe('backslashes at the storage gate', () => {
  it('refuses a backslash traversal out of the commons', () => {
    expect(storageUriForPath('shared/..\\apps\\vault\\secret.txt')).toBeNull();
    expect(canonicalStorageUri('yaar://storage/shared/..\\apps\\vault\\secret.txt')).toBeNull();
    expect(
      permissionsAllow([], 'notes', 'yaar://storage/shared/..\\apps\\vault\\secret.txt', 'read'),
    ).toBe(false);
  });

  it('reads backslash-separated app storage as that app, under the sharedOnly cap', () => {
    const capped = [{ uri: 'yaar://storage/', sharedOnly: true as const }];
    expect(permissionsAllow(capped, 'notes', 'yaar://storage/apps\\vault\\x', 'read')).toBe(false);
    expect(permissionsAllow(capped, 'notes', 'yaar://storage/apps/vault/x', 'read')).toBe(false);
  });

  it('decodes %5C in the REST path to the separator the disk will see', () => {
    const parsed = parseContentPath(
      decodeURIComponent('/api/storage/shared/..%5Capps%5Cvault%5Csecret.txt'),
    );
    expect(parsed).toEqual({ authority: 'storage', path: 'shared/../apps/vault/secret.txt' });
  });

  it('leaves an ordinary commons path alone', () => {
    expect(storageUriForPath('shared\\anima\\dragon.png')).toBe(
      'yaar://storage/shared/anima/dragon.png',
    );
    expect(permissionsAllow([], 'notes', 'yaar://storage/shared/anima/dragon.png', 'read')).toBe(
      true,
    );
  });
});
