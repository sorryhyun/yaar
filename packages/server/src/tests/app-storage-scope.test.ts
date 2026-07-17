/**
 * Regression test for the app-agent storage traversal gap.
 *
 * `mcp/app-agent` takes its storage path straight off a tool argument, and `storageRead` /
 * `storageWrite` only confine to STORAGE_DIR — not to the app's own subtree. So before
 * `scopedAppStoragePath` existed, `query(stateKey: "storage/../devtools/secrets.json")`
 * built `apps/notes/../devtools/secrets.json`, which normalizes to a path that is still
 * inside STORAGE_DIR and was therefore allowed: one app could read and write another's
 * storage, contradicting the app-agent prompt's own promise that storage is app-scoped.
 *
 * The guard lives next to the layout (`handlers/apps.ts`) rather than in the app-agent
 * door, so the two cannot drift apart. These tests pin the containment property itself:
 * whatever comes back must stay under `apps/{appId}/`.
 */
import { describe, it, expect } from 'bun:test';
import { normalize } from 'path';
import { appStoragePath, scopedAppStoragePath } from '../handlers/apps.js';

describe('scopedAppStoragePath', () => {
  it('builds an app-scoped path for an ordinary relative path', () => {
    expect(scopedAppStoragePath('notes', 'config.json')).toBe('apps/notes/config.json');
    expect(scopedAppStoragePath('notes', 'sub/dir/file.txt')).toBe('apps/notes/sub/dir/file.txt');
  });

  it('builds the storage root for an empty path', () => {
    expect(scopedAppStoragePath('notes', '')).toBe('apps/notes/');
  });

  it('strips a leading slash rather than rejecting it', () => {
    // Not an escape, and this door has always accepted it.
    expect(scopedAppStoragePath('notes', '/config.json')).toBe('apps/notes/config.json');
    expect(scopedAppStoragePath('notes', '//config.json')).toBe('apps/notes/config.json');
  });

  it('rejects traversal out of the app subtree', () => {
    expect(scopedAppStoragePath('notes', '../devtools/secrets.json')).toBeNull();
    expect(scopedAppStoragePath('notes', '..')).toBeNull();
    expect(scopedAppStoragePath('notes', 'sub/../../devtools/secrets.json')).toBeNull();
    // `command("storage:list", { path: ".." })` — enumerate every installed app.
    expect(scopedAppStoragePath('notes', '../')).toBeNull();
  });

  it('rejects traversal spelled with backslashes', () => {
    // storage-manager's resolvePath rewrites "\" to "/" before it resolves, so a
    // Windows-style separator escapes just as well as a POSIX one.
    expect(scopedAppStoragePath('notes', '..\\devtools\\secrets.json')).toBeNull();
  });

  it('never returns a path outside apps/{appId}/', () => {
    const hostile = [
      '../devtools/secrets.json',
      '..',
      '../',
      './../devtools',
      'a/../../b',
      '/../devtools',
      '..\\devtools',
      'a/./../../..',
    ];
    for (const input of hostile) {
      const result = scopedAppStoragePath('notes', input);
      if (result === null) continue;
      expect(normalize(result).replaceAll('\\', '/')).toStartWith('apps/notes/');
    }
  });

  it('documents the unguarded layout helper it wraps', () => {
    // appStoragePath is layout only — it is what made the traversal reachable, and callers
    // holding a raw path must not use it directly.
    expect(normalize(appStoragePath('notes', '../devtools/secrets.json'))).toBe(
      'apps/devtools/secrets.json',
    );
  });
});
