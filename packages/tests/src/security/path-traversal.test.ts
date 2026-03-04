/**
 * Security tests: path traversal prevention in storage resolution.
 *
 * resolveMountPath() must never allow a caller to escape the configured
 * mount's host directory, regardless of how many "../" segments they use.
 *
 * Also tests resolvePath() which wraps both STORAGE_DIR and mount resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── resolveMountPath (mount-scoped traversal) ─────────────────────────────

describe('resolveMountPath — mount-scoped path traversal', () => {
  let resolveMountPath: (typeof import('@yaar/server/storage/mounts'))['resolveMountPath'];
  let loadMounts: (typeof import('@yaar/server/storage/mounts'))['loadMounts'];

  beforeEach(async () => {
    // Reset module so cachedMounts is null again
    vi.resetModules();

    // Stub Bun.file to return a controlled mounts config
    vi.stubGlobal('Bun', {
      file: vi.fn((_path: string) => ({
        text: async () =>
          JSON.stringify([
            {
              alias: 'data',
              hostPath: '/tmp/testmount',
              readOnly: false,
              createdAt: new Date().toISOString(),
            },
          ]),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const mod = await import('@yaar/server/storage/mounts');
    resolveMountPath = mod.resolveMountPath;
    loadMounts = mod.loadMounts;

    // Populate cachedMounts
    await loadMounts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks classic ../.. traversal above a mounted alias', () => {
    // mounts/data/../../etc/passwd — tries to escape /tmp/testmount
    const result = resolveMountPath('mounts/data/../../etc/passwd');
    expect(result).toBeNull();
  });

  it('blocks deeply nested traversal', () => {
    const result = resolveMountPath('mounts/data/a/b/c/../../../../../../../../etc/shadow');
    expect(result).toBeNull();
  });

  it('blocks backslash traversal (Windows-style)', () => {
    const result = resolveMountPath('mounts\\data\\..\\..\\etc\\passwd');
    expect(result).toBeNull();
  });

  it('allows a valid sub-path within the mount', () => {
    const result = resolveMountPath('mounts/data/subdir/file.txt');
    expect(result).not.toBeNull();
    expect(result!.absolutePath).toContain('/tmp/testmount');
    expect(result!.absolutePath).toContain('subdir');
    // Sanity: resolved path should not contain '..'
    expect(result!.absolutePath).not.toContain('..');
  });

  it('returns null for unknown mount alias', () => {
    const result = resolveMountPath('mounts/unknown-alias/file.txt');
    expect(result).toBeNull();
  });
});

describe('resolveMountPath — without any mounts configured', () => {
  let resolveMountPath: (typeof import('@yaar/server/storage/mounts'))['resolveMountPath'];
  let loadMounts: (typeof import('@yaar/server/storage/mounts'))['loadMounts'];

  beforeEach(async () => {
    vi.resetModules();

    // Stub Bun.file to return empty mounts list
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({
        text: async () => JSON.stringify([]),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const mod = await import('@yaar/server/storage/mounts');
    resolveMountPath = mod.resolveMountPath;
    loadMounts = mod.loadMounts;
    await loadMounts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for any mounts/ path when no mounts are registered', () => {
    expect(resolveMountPath('mounts/any/path')).toBeNull();
  });

  it('returns null for non-mount paths', () => {
    expect(resolveMountPath('../../etc/passwd')).toBeNull();
    expect(resolveMountPath('../storage/secrets.json')).toBeNull();
    expect(resolveMountPath('/etc/passwd')).toBeNull();
  });
});

// ── resolvePath (STORAGE_DIR-scoped traversal) ────────────────────────────

describe('resolvePath — storage-scoped path traversal', () => {
  // resolvePath is in storage-manager.ts and uses STORAGE_DIR as the root.
  // We test that "../" sequences are rejected without needing mount setup.

  it('rejects paths that escape STORAGE_DIR', async () => {
    vi.resetModules();
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({ text: async () => JSON.stringify([]), arrayBuffer: async () => new ArrayBuffer(0) })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { resolvePath } = await import('@yaar/server/storage/storage-manager');
    expect(resolvePath('../../etc/passwd')).toBeNull();
    expect(resolvePath('../config/hooks.json')).toBeNull();
    expect(resolvePath('../../../root/.ssh/id_rsa')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('allows normal relative paths under STORAGE_DIR', async () => {
    vi.resetModules();
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({ text: async () => JSON.stringify([]), arrayBuffer: async () => new ArrayBuffer(0) })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { resolvePath } = await import('@yaar/server/storage/storage-manager');
    const result = resolvePath('documents/notes.txt');
    expect(result).not.toBeNull();
    expect(result!.absolutePath).not.toContain('..');
    expect(result!.readOnly).toBe(false);

    vi.unstubAllGlobals();
  });
});
