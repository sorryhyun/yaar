/**
 * Storage overrides: an app claiming a built-in `storage:*` spelling for its own command.
 *
 * The resolver is pure over a protocol's command table, so it is pinned here against
 * literal tables rather than apps on disk; the routing it feeds (`routeStorageOverride`
 * in `mcp/app-agent/index.ts`) runs only on the relative-path branch, which is the rule
 * the last block pins by reading the source — the shared tree must never override.
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

  it('is asked on the relative branches of query and command, and nowhere else', () => {
    // Two call sites: `query`'s `storage/` branch and `command`'s relative branch.
    expect(src.split('await routeStorageOverride(').length - 1).toBe(2);
  });

  it('is never asked on the shared tree', () => {
    // The shared branch is `sharedStorageCommand` / the `namesSharedStorage` block, and
    // neither mentions the override: the app.json gate stays between agent and bytes.
    const shared = src.slice(
      src.indexOf('async function sharedStorageCommand('),
      src.indexOf('export function registerAppAgentTools'),
    );
    expect(shared).not.toContain('routeStorageOverride');
    const queryShared = src.slice(
      src.indexOf('if (stateKey && namesSharedStorage(stateKey))'),
      src.indexOf("if (stateKey?.startsWith('storage/')"),
    );
    expect(queryShared).not.toContain('routeStorageOverride');
  });
});
