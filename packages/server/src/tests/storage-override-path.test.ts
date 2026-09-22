/**
 * The storage-override path contract on the doors that forward commands (#91): an
 * override only ever receives a relative path or a commons URI, whichever door called it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  gatedStoragePath,
  isStorageOverrideCommand,
} from '../features/window/storage-override-path.js';

describe('gatedStoragePath', () => {
  it('lets through what an override may receive', () => {
    expect(gatedStoragePath({ path: 'report.docx' })).toBeNull();
    expect(gatedStoragePath({ path: 'yaar://storage/shared/report.docx' })).toBeNull();
    expect(gatedStoragePath({ path: 'yaar://storage/shared' })).toBeNull();
    expect(gatedStoragePath({})).toBeNull();
    expect(gatedStoragePath(undefined)).toBeNull();
    expect(gatedStoragePath({ path: 42 })).toBeNull();
  });

  it('names the shared tree past the commons', () => {
    expect(gatedStoragePath({ path: 'yaar://storage/temp/qa-test.md' })).toBe(
      'yaar://storage/temp/qa-test.md',
    );
    expect(gatedStoragePath({ path: 'yaar://storage' })).toBe('yaar://storage');
    // Not a commons sibling that merely shares the prefix.
    expect(gatedStoragePath({ path: 'yaar://storage/shared-x/a' })).toBe(
      'yaar://storage/shared-x/a',
    );
  });

  it('does not let a traversal out of the commons pass as the commons', () => {
    expect(gatedStoragePath({ path: 'yaar://storage/shared/../temp/x' })).toBe(
      'yaar://storage/shared/../temp/x',
    );
  });
});

describe('isStorageOverrideCommand', () => {
  it('is the built-in spellings, without a manifest', () => {
    expect(isStorageOverrideCommand('storage:write', undefined)).toBe(true);
    expect(isStorageOverrideCommand('storage:list', undefined)).toBe(true);
    expect(isStorageOverrideCommand('storage:writeAll', undefined)).toBe(false);
    expect(isStorageOverrideCommand('exportTo', undefined)).toBe(false);
  });

  it('is a command whose aliases claim a built-in spelling', () => {
    const commands = {
      saveToStorage: { description: 'save', aliases: ['storage:write'] },
      exportTo: { description: 'export', aliases: ['export'] },
    };
    expect(isStorageOverrideCommand('saveToStorage', commands)).toBe(true);
    expect(isStorageOverrideCommand('exportTo', commands)).toBe(false);
  });
});

describe('where the contract is kept', () => {
  it('is asked in handleAppCommand, before anything is forwarded to the app', () => {
    const src = readFileSync(
      new URL('../features/window/app-protocol.ts', import.meta.url),
      'utf8',
    );
    const start = src.indexOf('export async function handleAppCommand(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start);
    const guard = body.indexOf('gatedStoragePath(params)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(body.indexOf('await request(key, req'));
    expect(guard).toBeLessThan(body.indexOf('grantWindowAccess('));
  });
});
