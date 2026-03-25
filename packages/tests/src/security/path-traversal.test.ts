/**
 * Security tests: path traversal prevention in storage resolution.
 *
 * resolveMountPath() must never allow a caller to escape the configured
 * mount's host directory, regardless of how many "../" segments they use.
 *
 * Also tests resolvePath() which wraps both STORAGE_DIR and mount resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolveMountPath, _setMountsForTest } from '@yaar/server/storage/mounts';
import { resolvePath } from '@yaar/server/storage/storage-manager';

// ── resolveMountPath (mount-scoped traversal) ─────────────────────────────

describe('resolveMountPath — mount-scoped path traversal', () => {
  beforeEach(() => {
    _setMountsForTest([
      {
        alias: 'data',
        hostPath: '/tmp/testmount',
        readOnly: false,
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(() => {
    _setMountsForTest(null);
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
  beforeEach(() => {
    _setMountsForTest([]);
  });

  afterEach(() => {
    _setMountsForTest(null);
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

  beforeEach(() => {
    // Ensure no mounts interfere with resolvePath's mount check
    _setMountsForTest([]);
  });

  afterEach(() => {
    _setMountsForTest(null);
  });

  it('rejects paths that escape STORAGE_DIR', () => {
    expect(resolvePath('../../etc/passwd')).toBeNull();
    expect(resolvePath('../config/hooks.json')).toBeNull();
    expect(resolvePath('../../../root/.ssh/id_rsa')).toBeNull();
  });

  it('allows normal relative paths under STORAGE_DIR', () => {
    const result = resolvePath('documents/notes.txt');
    expect(result).not.toBeNull();
    expect(result!.absolutePath).not.toContain('..');
    expect(result!.readOnly).toBe(false);
  });
});
