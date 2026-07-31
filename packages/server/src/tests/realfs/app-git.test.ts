/**
 * Real-filesystem tests — these run real `git` against real app directories.
 *
 * That is what `src/tests/realfs/` is for, and the reason it gets a process of its own
 * (`scripts/test/partitions.ts`) is the mocks rather than the git: several unit tests in
 * `src/tests/` call `mock.module('../config.js', …)` with `PROJECT_ROOT: '/mock-root'`.
 * Bun hoists `mock.module` and applies it process-wide with no teardown, so any test
 * sharing that process which resolves a real path through `PROJECT_ROOT` dies with
 * `EACCES: mkdir '/mock-root'`, regardless of file order.
 *
 * This is not the *integration* suite — that is `packages/tests/src/integration/`, which
 * boots the server and drives it over HTTP and WebSocket. Nothing here starts a server.
 *
 * A `bun test src/tests` run collects this directory alongside the units, which is a
 * mixed process; `scripts/test/partition-guard.ts` stops such a run and prints the command
 * for each partition, the same way it does for `remote/` and `loopback/` next door.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../../config.js';
import { USER_APPS_DIR } from '../../features/apps/roots.js';
import { snapshotApp, appHistory, appDiff, restoreApp } from '../../features/dev/git.js';

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
    // App-relative, like the snapshot base — `AppDiffResult.files` says "relative to
    // the app directory", and this branch used to be the one that broke that promise
    // by passing git's repo-relative output straight through. A caller cannot feed a
    // path back as `paths` (or into a read) if which of the two it is depends on which
    // base was asked for.
    expect(diff.files.every((f) => !f.startsWith('apps/'))).toBe(true);
  });

  it('answers how much changed without the diff text', async () => {
    // The whole point of statOnly: the counts arrive without the body. A whole-app
    // diff is tens of kilobytes, which is what made a routine pre-deploy check
    // expensive enough to skip.
    const diff = await appDiff('devtools', { against: 'repo', statOnly: true });
    expect(diff.success).toBe(true);
    if (!diff.success) return;
    expect(diff.diff).toBe('');
    expect(diff.stat).toBeDefined();
    expect(diff.stat!.map((s) => s.file).sort()).toEqual([...diff.files].sort());
    for (const row of diff.stat!) {
      expect(Number.isFinite(row.added)).toBe(true);
      expect(Number.isFinite(row.removed)).toBe(true);
    }
  });

  it('narrows a snapshot diff to the paths asked for', async () => {
    await snapshotApp(APP_ID, 'baseline for paths');
    await writeFile(join(appDir, 'src', 'app.ts'), 'export const v = 2;\n');
    await writeFile(join(appDir, 'other.txt'), 'also changed\n');

    const all = await appDiff(APP_ID, { statOnly: true });
    expect(all.success).toBe(true);
    if (!all.success) return;
    expect(all.files.sort()).toEqual(['other.txt', 'src/app.ts']);

    const narrowed = await appDiff(APP_ID, { statOnly: true, paths: ['src/app.ts'] });
    expect(narrowed.success).toBe(true);
    if (!narrowed.success) return;
    expect(narrowed.files).toEqual(['src/app.ts']);
  });

  it('refuses a paths list that escapes the app directory', async () => {
    // These become a git pathspec, so `..` would name files outside the app. A list
    // whose every entry is dropped is reported rather than silently read as "nothing
    // changed" — the answer a caller would otherwise act on.
    const diff = await appDiff(APP_ID, { paths: ['../elsewhere'] });
    expect(diff.success).toBe(false);
    if (diff.success) return;
    expect(diff.error).toContain('paths');
  });
});
