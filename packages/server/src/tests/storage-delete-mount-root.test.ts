/**
 * Deleting `yaar://storage/mounts/{alias}`.
 *
 * A mount root is the one storage path that is not storage: `resolveMountPath` maps it
 * to the mounted *host* directory, and `storageDelete`'s recursive branch would then
 * `rm -rf` that folder — the user's real `~/Documents`, say — on a path that reads like
 * removing a single storage entry. Nothing asks first: mounting shows a permission
 * dialog, unmounting is a config edit that leaves the host alone, but this door had
 * neither. So the root is refused, in every spelling that lands on it, while paths
 * *inside* the mount stay ordinary deletes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { storageDelete } from '../storage/storage-manager.js';
import { _setMountsForTest, type MountEntry } from '../storage/mounts.js';

let hostDir = '';

/** Install a single mount pointing at a real, populated host directory. */
async function mount(readOnly = false): Promise<void> {
  await writeFile(join(hostDir, 'keep.txt'), 'precious');
  await mkdir(join(hostDir, 'sub'), { recursive: true });
  await writeFile(join(hostDir, 'sub', 'inner.txt'), 'also precious');

  const entry: MountEntry = {
    alias: 'docs',
    hostPath: hostDir,
    readOnly,
    createdAt: new Date().toISOString(),
  };
  _setMountsForTest([entry]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  hostDir = await mkdtemp(join(tmpdir(), 'yaar-mount-root-'));
});

afterEach(async () => {
  _setMountsForTest(null);
  await rm(hostDir, { recursive: true, force: true });
});

describe('storageDelete on a mount root', () => {
  // Every spelling that resolves to the host directory itself, including the ones that
  // only collapse to it after normalization.
  for (const path of ['mounts/docs', 'mounts/docs/', 'mounts/docs/.', 'mounts/docs/sub/..']) {
    it(`refuses "${path}" and leaves the host directory intact`, async () => {
      await mount();

      const result = await storageDelete(path);

      expect(result.success).toBe(false);
      expect(result.error).toContain('mount root');
      // The refusal names the door that actually unmounts.
      expect(result.error).toContain('yaar://config/mounts/docs');
      expect(await exists(hostDir)).toBe(true);
      expect(await exists(join(hostDir, 'keep.txt'))).toBe(true);
      expect(await exists(join(hostDir, 'sub', 'inner.txt'))).toBe(true);
    });
  }

  it('still deletes a path inside the mount', async () => {
    await mount();

    const result = await storageDelete('mounts/docs/sub');

    expect(result.success).toBe(true);
    expect(await exists(join(hostDir, 'sub'))).toBe(false);
    expect(await exists(join(hostDir, 'keep.txt'))).toBe(true);
  });

  it('reports a read-only mount as read-only rather than as a root', async () => {
    await mount(true);

    const result = await storageDelete('mounts/docs');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Mount is read-only');
    expect(await exists(hostDir)).toBe(true);
  });

  it('does not refuse an unmounted alias, which is a plain storage path', async () => {
    _setMountsForTest([]);

    // `storage/mounts/nothing` does not exist on disk, so this is an ordinary miss —
    // not the mount-root refusal.
    const result = await storageDelete('mounts/nothing');

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('mount root');
  });
});
