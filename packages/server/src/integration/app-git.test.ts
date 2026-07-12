/**
 * Filesystem integration tests — these run real `git` against real app directories.
 *
 * They live in `src/integration/`, not `src/tests/`, and run as a second `bun test`
 * process (see this package's `test` script). Several unit tests in `src/tests/`
 * call `mock.module('../config.js', …)` with `PROJECT_ROOT: '/mock-root'`; Bun
 * hoists `mock.module` and applies it process-wide, so any test sharing that
 * process which touches the real filesystem via `PROJECT_ROOT` dies with
 * `EACCES: mkdir '/mock-root'`, regardless of file order.
 *
 * The directory name must not be a superstring of `src/tests` — Bun treats a path
 * argument as a substring filter, so `bun test src/tests` would also match
 * `src/tests-integration/` and pull these back into the poisoned process.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../config.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { snapshotApp, appHistory, appDiff, restoreApp } from '../features/dev/git.js';

// A real app directory is required — `resolveAppDir` only sees apps on disk.
// `user-apps/` is git-ignored, so a fixture here cannot dirty the working tree.
const APP_ID = 'app-git-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);
const shadowDir = join(getStorageDir(), 'app-git', `${APP_ID}.git`);

async function seed(files: Record<string, string>): Promise<void> {
  await rm(appDir, { recursive: true, force: true });
  await rm(shadowDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(appDir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
}

async function cleanup(): Promise<void> {
  await rm(appDir, { recursive: true, force: true });
  await rm(shadowDir, { recursive: true, force: true });
}

afterAll(cleanup);

describe('app version history', () => {
  beforeEach(async () => {
    // No src/main.ts: restore skips the (slow) recompile, which the deploy path
    // covers separately.
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'src/app.ts': 'export const v = 1;\n',
      'dist/index.html': '<html>generated</html>\n',
      'credentials.json': '{"token":"SECRET"}\n',
    });
  });

  it('creates the shadow repo outside the app directory', async () => {
    await snapshotApp(APP_ID, 'first');

    expect(existsSync(shadowDir)).toBe(true);
    // The whole point: the user's repo must never see a nested .git.
    expect(existsSync(join(appDir, '.git'))).toBe(false);
  });

  it('records snapshots as commits, newest first', async () => {
    await snapshotApp(APP_ID, 'first');
    await writeFile(join(appDir, 'src', 'app.ts'), 'export const v = 2;\n');
    await snapshotApp(APP_ID, 'second');

    const history = await appHistory(APP_ID);
    expect(history.success).toBe(true);
    if (!history.success) return;
    expect(history.commits.map((c) => c.message)).toEqual(['second', 'first']);
    expect(history.commits[0].shortHash).toHaveLength(7);
  });

  it('never snapshots generated output or credentials', async () => {
    await snapshotApp(APP_ID, 'first');
    await writeFile(join(appDir, 'dist', 'index.html'), '<html>rebuilt</html>\n');
    await writeFile(join(appDir, 'credentials.json'), '{"token":"ROTATED"}\n');

    const diff = await appDiff(APP_ID);
    expect(diff.success).toBe(true);
    if (!diff.success) return;
    // dist/ is rebuilt from source, and credentials must not enter any repo.
    expect(diff.files).toEqual([]);
  });

  it('diffs the working tree against a commit', async () => {
    await snapshotApp(APP_ID, 'first');
    await writeFile(join(appDir, 'src', 'app.ts'), 'export const v = 2;\n');
    await writeFile(join(appDir, 'src', 'added.ts'), 'export const extra = true;\n');

    const diff = await appDiff(APP_ID);
    expect(diff.success).toBe(true);
    if (!diff.success) return;
    expect(diff.against).toBe('snapshot');
    expect(diff.files.sort()).toEqual(['src/added.ts', 'src/app.ts']);
    // A file git has never seen still shows up — appDiff stages before diffing.
    expect(diff.diff).toContain('export const extra = true;');
  });

  it('restores an earlier commit, deleting files added since', async () => {
    await snapshotApp(APP_ID, 'v1');
    await writeFile(join(appDir, 'src', 'app.ts'), 'export const v = 2;\n');
    await writeFile(join(appDir, 'src', 'added.ts'), 'export const extra = true;\n');
    await snapshotApp(APP_ID, 'v2');

    const result = await restoreApp(APP_ID, 'HEAD~1');
    expect(result.success).toBe(true);

    expect(await Bun.file(join(appDir, 'src', 'app.ts')).text()).toContain('v = 1');
    // `checkout -- .` would leave this behind; `read-tree -u --reset` removes it.
    expect(existsSync(join(appDir, 'src', 'added.ts'))).toBe(false);
  });

  it('keeps history append-only so a restore can itself be undone', async () => {
    await snapshotApp(APP_ID, 'v1');
    await writeFile(join(appDir, 'src', 'app.ts'), 'export const v = 2;\n');
    await snapshotApp(APP_ID, 'v2');

    await restoreApp(APP_ID, 'HEAD~1');

    const history = await appHistory(APP_ID);
    expect(history.success).toBe(true);
    if (!history.success) return;
    // The version we rolled back from is still reachable.
    const v2 = history.commits.find((c) => c.message === 'v2');
    expect(v2).toBeDefined();

    const rollForward = await restoreApp(APP_ID, v2!.hash);
    expect(rollForward.success).toBe(true);
    expect(await Bun.file(join(appDir, 'src', 'app.ts')).text()).toContain('v = 2');
  });

  it('rejects refs that git would parse as flags', async () => {
    await snapshotApp(APP_ID, 'first');

    for (const ref of [
      '--upload-pack=touch /tmp/pwned',
      '-x',
      'HEAD; rm -rf /',
      '$(whoami)',
      'main',
    ]) {
      const diff = await appDiff(APP_ID, { ref });
      expect(diff.success).toBe(false);
      const restore = await restoreApp(APP_ID, ref);
      expect(restore.success).toBe(false);
    }
  });

  it('reports a missing app rather than creating one', async () => {
    const history = await appHistory('no-such-app');
    expect(history.success).toBe(false);
    expect(existsSync(join(getStorageDir(), 'app-git', 'no-such-app.git'))).toBe(false);
  });

  it('refuses a host-repo diff for user-installed apps', async () => {
    // `user-apps/` is git-ignored, so the host repo has no history for it —
    // saying so beats returning a silently empty diff.
    const diff = await appDiff(APP_ID, { against: 'repo' });
    expect(diff.success).toBe(false);
    if (diff.success) return;
    expect(diff.error).toContain('snapshot');
  });

  it('diffs a bundled app against the user repo', async () => {
    const diff = await appDiff('devtools', { against: 'repo' });
    expect(diff.success).toBe(true);
    if (!diff.success) return;
    expect(diff.against).toBe('repo');
    // Read-only: reading a diff must never mutate the user's index or HEAD.
    expect(diff.files.every((f) => f.startsWith('apps/devtools/'))).toBe(true);
  });
});
