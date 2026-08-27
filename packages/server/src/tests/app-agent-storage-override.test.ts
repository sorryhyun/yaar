/**
 * Storage overrides: an app claiming a built-in `storage:*` spelling for its own command.
 *
 * The resolver is pure over a protocol's command table, so it is pinned here against
 * literal tables rather than apps on disk; the routing it feeds (`routeStorageOverride`
 * in `mcp/app-agent/index.ts`) runs on the app's own tree and on the commons (`shared/`,
 * which costs no permission and so has no gate to stand in front of), and nowhere else —
 * the rule the last block pins by reading the source. The rest of the shared tree is
 * admitted only by app.json, so it must never override.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  findStorageOverride,
  overrideNote,
  storageOverrideIn,
  STORAGE_VERBS,
} from '../mcp/app-agent/storage-override.js';

describe('storageOverrideIn', () => {
  it('finds a command declared under the built-in name itself', () => {
    const commands = { 'storage:write': { description: 'save the document' } };
    expect(storageOverrideIn(commands, 'write')).toBe('storage:write');
    expect(storageOverrideIn(commands, 'read')).toBeNull();
  });

  it('finds a command that aliases the built-in name, and answers with the canonical one', () => {
    const commands = {
      saveToStorage: { description: 'save', aliases: ['storage:write', 'save'] },
      readStorageFile: { description: 'read', aliases: ['storage:read'] },
    };
    expect(storageOverrideIn(commands, 'write')).toBe('saveToStorage');
    expect(storageOverrideIn(commands, 'read')).toBe('readStorageFile');
    expect(storageOverrideIn(commands, 'delete')).toBeNull();
    expect(storageOverrideIn(commands, 'list')).toBeNull();
  });

  it('is null for an app with no protocol at all', () => {
    for (const verb of STORAGE_VERBS) expect(storageOverrideIn(undefined, verb)).toBeNull();
  });

  it('does not mistake a similarly named command for an override', () => {
    const commands = {
      storageWrite: { description: 'x' },
      'storage:writeAll': { description: 'y' },
    };
    expect(storageOverrideIn(commands, 'write')).toBeNull();
  });
});

describe('findStorageOverride', () => {
  it('is null for a bundled app that overrides nothing, and for a missing app', async () => {
    expect(await findStorageOverride('memo', 'write')).toBeNull();
    expect(await findStorageOverride('no-such-app', 'read')).toBeNull();
  });
});

describe('overrideNote', () => {
  it('names the built-in, and the app command when it is a different name', () => {
    expect(overrideNote('write', 'storage:write')).toContain(
      'overrides the built-in storage:write',
    );
    expect(overrideNote('write', 'saveToStorage')).toContain('with its "saveToStorage" command');
  });
});

describe('where the route is asked', () => {
  const src = readFileSync(new URL('../mcp/app-agent/index.ts', import.meta.url), 'utf8');

  /**
   * Slice between two anchors, each of which must be present and in order. Reading the
   * source is only worth anything while the anchors still hit: a stale one used to slice
   * to `''` and pass every `not.toContain` below for free.
   */
  const between = (from: string, to: string): string => {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start + from.length);
    expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
    expect(end, `anchor not found after "${from}": ${to}`).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('is asked on the relative branches and the commons, and nowhere else', () => {
    // Four call sites: `query` and `command` each ask once on the app's own tree and once
    // on the commons, which is ungated and so the app's to override like its own tree.
    expect(src.split('await routeStorageOverride(').length - 1).toBe(4);
  });

  it('is asked on the shared tree only behind the commons guard', () => {
    // `query`'s shared branch: the ask sits inside `if (namesCommons(...))`, so a path
    // deeper in the shared tree reaches the app.json gate without passing the app first.
    const queryShared = between(
      'if (stateKey && namesSharedStorage(stateKey)) {',
      "if (stateKey?.startsWith('storage/') || stateKey === 'storage') {",
    );
    expect(queryShared).toContain('routeStorageOverride');
    expect(queryShared.indexOf('namesCommons(')).toBeGreaterThanOrEqual(0);
    expect(queryShared.indexOf('namesCommons(')).toBeLessThan(
      queryShared.indexOf('routeStorageOverride'),
    );

    // `command`'s shared branch, same shape.
    const commandShared = between(
      'if (namesSharedStorage(path)) {',
      'const scoped = scopedAppStoragePath(appId, path);',
    );
    expect(commandShared).toContain('routeStorageOverride');
    expect(commandShared.indexOf('namesCommons(')).toBeGreaterThanOrEqual(0);
    expect(commandShared.indexOf('namesCommons(')).toBeLessThan(
      commandShared.indexOf('routeStorageOverride'),
    );
  });

  it('is never asked below the commons, once the gated tree is being served', () => {
    // `sharedStorageCommand` is what the gated tree is served by, and it does not mention
    // the override: past the commons, the app.json gate stays between agent and bytes.
    const shared = between(
      'async function sharedStorageCommand(',
      'export function registerAppAgentTools',
    );
    expect(shared).not.toContain('routeStorageOverride');
  });
});
