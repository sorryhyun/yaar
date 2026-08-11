/**
 * Per-app version history — a shadow git repo per app.
 *
 * The app directory *is* the git work-tree, so "the app boundary" is enforced by
 * git itself rather than by pathspec filtering we'd have to keep correct. The
 * repo metadata lives in `storage/app-git/<appId>.git` (git-ignored), never
 * inside the app directory: the user's own repo therefore sees no nested `.git`
 * and their history is never polluted with agent commits.
 *
 * Deploy is otherwise destructive and unrecoverable — `syncDir` deletes files no
 * longer present in the source and `dist/` is wiped. A snapshot on either side of
 * a deploy makes every deploy undoable via `restoreApp()`.
 *
 * Two diff bases, answering different questions:
 *  - `snapshot` — working tree vs a shadow-repo commit. "What changed since the
 *    last deploy?" Works for bundled *and* user-installed apps.
 *  - `repo`     — the user's own repo, `git diff -- apps/<id>/`. "What has the
 *    agent changed relative to what I committed?" Read-only, bundled apps only
 *    (`user-apps/` is git-ignored, so the host repo cannot see it).
 */

import { join, relative } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { PROJECT_ROOT, getStorageDir } from '../../config.js';
import { APPS_DIR, appIdRefusal, resolveAppDir, resolveAppSource } from '../apps/roots.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('app-git');

/**
 * Shadow repos live under the storage dir (git-ignored), never inside the app dir.
 * Resolved lazily through `getStorageDir()` rather than `join(PROJECT_ROOT, 'storage')`
 * so a `YAAR_STORAGE` override is honoured.
 */
function appGitRoot(): string {
  return join(getStorageDir(), 'app-git');
}

function gitDirFor(appId: string): string {
  return join(appGitRoot(), `${appId}.git`);
}

const COMMIT_AUTHOR_NAME = 'YAAR devtools';
const COMMIT_AUTHOR_EMAIL = 'devtools@yaar.local';

/**
 * Never snapshot generated output or secrets. `dist/` is rebuilt from source on
 * demand, and `credentials.json` holds app secrets that must not enter any repo
 * (the host `.gitignore` excludes both for the same reason).
 */
const EXCLUDE_PATTERNS = [
  'dist/',
  'dist.staging/',
  'credentials.json',
  'node_modules/',
  '.build-manifest.json',
];

/** A commit in an app's shadow history. */
export interface AppCommit {
  hash: string;
  shortHash: string;
  /** Unix ms. */
  timestamp: number;
  message: string;
}

export type GitFailure = { success: false; error: string };

/**
 * A ref the agent is allowed to name. Deliberately narrow: a full/short SHA, or
 * `HEAD` with an optional `~N`. Anything looser (`--upload-pack=…`, `-x`, refs
 * with `..`) would land in argv position where git parses it as a flag.
 */
const REF_PATTERN = /^(?:[0-9a-f]{7,40}|HEAD(?:~\d+)?)$/;

function isValidRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run git with an explicit argv (never a shell string) against a shadow repo.
 *
 * The environment is scrubbed of the user's global/system gitconfig: those can
 * carry `core.fsmonitor`, `core.hooksPath` or commit-signing hooks, all of which
 * turn an innocuous `git status` into arbitrary command execution on the user's
 * machine. A fresh `git init` ships only non-executable sample hooks, and
 * `core.hooksPath=/dev/null` keeps it that way.
 */
async function runGit(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
    // git resolves relative pathspecs against the *cwd*, not the work tree, so
    // this must be the work tree or a pathspec like `apps/foo` silently matches
    // nothing.
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr: stderr.trim() };
}

/** Env pinning git to an app's shadow repo (metadata) + app dir (work tree). */
function shadowEnv(appId: string, appPath: string): Record<string, string> {
  return {
    GIT_DIR: gitDirFor(appId),
    GIT_WORK_TREE: appPath,
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
  };
}

/** Resolve an app's directory, or an error if it doesn't exist. */
function appDirOrError(appId: string): { path: string } | GitFailure {
  const refusal = appIdRefusal(appId);
  if (refusal) return { success: false, error: refusal };
  const path = resolveAppDir(appId);
  if (!path) return { success: false, error: `App "${appId}" not found.` };
  return { path };
}

/**
 * Create the shadow repo on first use. Deliberately does *not* commit a baseline:
 * the caller's own message is always the more accurate label for whatever is on
 * disk. For an app that predates its history, the first commit is the
 * `checkpoint: before deploy` that `doDeploy` takes *before* mutating anything —
 * which is exactly the baseline, correctly named. Committing here as well would
 * leave the caller's commit a no-op on a now-clean tree, silently dropping its
 * message.
 */
async function ensureRepo(appId: string, appPath: string): Promise<GitFailure | null> {
  const gitDir = gitDirFor(appId);
  if (existsSync(gitDir)) return null;

  await mkdir(appGitRoot(), { recursive: true });

  const init = await runGit(['init', '-q', '-b', 'main'], shadowEnv(appId, appPath), appPath);
  if (!init.ok) {
    return { success: false, error: `Failed to init history for "${appId}": ${init.stderr}` };
  }

  await mkdir(join(gitDir, 'info'), { recursive: true });
  await Bun.write(join(gitDir, 'info', 'exclude'), EXCLUDE_PATTERNS.join('\n') + '\n');
  return null;
}

/**
 * Stage everything and commit. Returns null when the tree is clean (nothing to
 * commit is a normal outcome, not a failure — e.g. a deploy that changed nothing,
 * or a pre-restore checkpoint when HEAD already captures the current state).
 */
async function commitAll(
  appId: string,
  appPath: string,
  message: string,
): Promise<GitFailure | null> {
  const env = shadowEnv(appId, appPath);

  const add = await runGit(['add', '-A'], env, appPath);
  if (!add.ok) return { success: false, error: `git add failed: ${add.stderr}` };

  const status = await runGit(['status', '--porcelain'], env, appPath);
  if (status.ok && status.stdout.trim() === '') return null; // clean tree

  const commit = await runGit(['commit', '-q', '-m', message], env, appPath);
  if (!commit.ok) return { success: false, error: `git commit failed: ${commit.stderr}` };
  return null;
}

/**
 * Snapshot an app's current on-disk state. Safe to call on every deploy: a clean
 * tree is a no-op. Never throws — history is a safety net, and a failure to
 * record one must not take down the deploy it was protecting.
 */
export async function snapshotApp(appId: string, message: string): Promise<void> {
  try {
    const dir = resolveAppDir(appId);
    if (!dir) return; // app dir not created yet (first deploy) — nothing to snapshot
    const initErr = await ensureRepo(appId, dir);
    if (initErr) {
      log.warn(initErr.error, { appId });
      return;
    }
    const err = await commitAll(appId, dir, message);
    if (err) log.warn(err.error, { appId });
  } catch (err) {
    log.warn('snapshot failed', { appId, err });
  }
}

/** Commits for an app, newest first. */
export async function appHistory(
  appId: string,
  limit = 30,
): Promise<{ success: true; commits: AppCommit[] } | GitFailure> {
  const dir = appDirOrError(appId);
  if ('success' in dir) return dir;

  const initErr = await ensureRepo(appId, dir.path);
  if (initErr) return initErr;

  const n = Math.min(Math.max(Math.trunc(limit) || 30, 1), 200);
  const env = shadowEnv(appId, dir.path);
  // NUL-delimited so commit subjects containing the separator can't forge fields.
  const log = await runGit(['log', `--max-count=${n}`, '--format=%H%x00%at%x00%s'], env, dir.path);
  if (!log.ok) {
    // A repo with no commits yet exits non-zero on `log` — that's an empty history.
    if (/does not have any commits/i.test(log.stderr)) return { success: true, commits: [] };
    return { success: false, error: `git log failed: ${log.stderr}` };
  }

  const commits: AppCommit[] = [];
  for (const line of log.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [hash, ts, ...rest] = line.split('\0');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      timestamp: Number(ts) * 1000,
      message: rest.join('\0'),
    });
  }
  return { success: true, commits };
}

export interface AppDiffResult {
  success: true;
  /** Unified diff. Empty string means no changes — and under `statOnly`, always empty. */
  diff: string;
  /** Paths touched, relative to the app directory. */
  files: string[];
  /** Per-file line counts. Present under `statOnly`, where they stand in for the diff. */
  stat?: { file: string; added: number; removed: number }[];
  /** Which base the diff was taken against. */
  against: 'snapshot' | 'repo';
  /** Present when `against: 'snapshot'`. */
  ref?: string;
  /** True when the diff was clipped to stay under the size cap. */
  truncated: boolean;
}

export interface AppDiffOptions {
  ref?: string;
  against?: 'snapshot' | 'repo';
  /**
   * Return per-file line counts instead of the diff text.
   *
   * "How much changed" is the question most often asked here — before a deploy, to
   * see whether an app has drifted from the repo — and the full answer to it is
   * 95KB for one app against `HEAD~1`, which is a real cost paid to learn one
   * number. `git diff --numstat` answers it in a few hundred bytes.
   */
  statOnly?: boolean;
  /**
   * Limit the diff to these paths, relative to the app directory. The usual follow-up
   * to a `statOnly` read: get the shape, then read the one file that matters.
   */
  paths?: string[];
}

/** A diff big enough to blow an agent's context is worse than no diff. */
const MAX_DIFF_BYTES = 200_000;

/**
 * Diff an app's working tree.
 *
 * `against: 'snapshot'` (default) compares the app dir to a shadow-repo commit —
 * "what changed since the last deploy". `against: 'repo'` compares against the
 * user's own git repo — "what has the agent changed relative to what I
 * committed" — and is read-only and bundled-apps-only.
 */
export async function appDiff(
  appId: string,
  opts: AppDiffOptions = {},
): Promise<AppDiffResult | GitFailure> {
  const dir = appDirOrError(appId);
  if ('success' in dir) return dir;

  const against = opts.against ?? 'snapshot';
  const paths = sanitizePaths(opts.paths);
  if (paths && paths.length === 0) {
    return { success: false, error: '"paths" was given but held no usable path.' };
  }

  if (against === 'repo') {
    if (resolveAppSource(appId) !== 'bundled') {
      return {
        success: false,
        error: `"${appId}" is a user-installed app; it lives in the git-ignored user-apps/ tree and has no host-repo history. Use against: "snapshot" instead.`,
      };
    }
    // Read-only against the host repo: `diff` never touches the index or HEAD.
    const appDirspec = relative(PROJECT_ROOT, join(APPS_DIR, appId));
    // A caller's paths are app-relative, so they are re-anchored under the app dir —
    // which also keeps the pathspec inside it whatever the caller passed.
    const pathspec = paths ? paths.map((p) => `${appDirspec}/${p}`) : [appDirspec];
    const env = { GIT_DIR: join(PROJECT_ROOT, '.git'), GIT_WORK_TREE: PROJECT_ROOT };
    const names = await runGit(['diff', '--numstat', '--', ...pathspec], env, PROJECT_ROOT);
    if (!names.ok) return { success: false, error: `git diff failed: ${names.stderr}` };
    const stat = parseNumstat(names.stdout, appDirspec);
    if (opts.statOnly) {
      return {
        success: true,
        diff: '',
        files: stat.map((s) => s.file),
        stat,
        against: 'repo',
        truncated: false,
      };
    }
    const diff = await runGit(['diff', '--', ...pathspec], env, PROJECT_ROOT);
    if (!diff.ok) return { success: false, error: `git diff failed: ${diff.stderr}` };
    return {
      success: true,
      ...clip(diff.stdout),
      files: stat.map((s) => s.file),
      against: 'repo',
    };
  }

  const ref = opts.ref ?? 'HEAD';
  if (!isValidRef(ref)) {
    return { success: false, error: `Invalid ref "${ref}". Use a commit hash or HEAD~N.` };
  }

  const initErr = await ensureRepo(appId, dir.path);
  if (initErr) return initErr;

  const env = shadowEnv(appId, dir.path);
  // Stage first so newly added files show up — `git diff <ref>` alone ignores
  // files git has never seen.
  const add = await runGit(['add', '-A'], env, dir.path);
  if (!add.ok) return { success: false, error: `git add failed: ${add.stderr}` };

  const limit = paths ? ['--', ...paths] : [];
  const names = await runGit(['diff', '--numstat', ref, ...limit], env, dir.path);
  if (!names.ok) return { success: false, error: `git diff failed: ${names.stderr}` };
  const stat = parseNumstat(names.stdout);

  if (opts.statOnly) {
    return {
      success: true,
      diff: '',
      files: stat.map((s) => s.file),
      stat,
      against: 'snapshot',
      ref,
      truncated: false,
    };
  }

  const diff = await runGit(['diff', ref, ...limit], env, dir.path);
  if (!diff.ok) return { success: false, error: `git diff failed: ${diff.stderr}` };

  return {
    success: true,
    ...clip(diff.stdout),
    files: stat.map((s) => s.file),
    against: 'snapshot',
    ref,
  };
}

function clip(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_BYTES) return { diff, truncated: false };
  return { diff: diff.slice(0, MAX_DIFF_BYTES), truncated: true };
}

/**
 * Drop anything in a caller's `paths` that could reach outside the app directory.
 *
 * These become a git pathspec, so a leading `/`, a `..`, or a `:`-prefixed magic
 * pathspec would each mean something other than "a file in this app". Silently
 * ignored rather than rejected one by one — an empty result is reported by the
 * caller, so a `paths` that named nothing usable cannot read as "nothing changed".
 */
function sanitizePaths(paths?: string[]): string[] | undefined {
  if (!paths) return undefined;
  return paths
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().replace(/^\/+/, ''))
    .filter((p) => p.length > 0 && !p.startsWith(':') && !p.split('/').includes('..'));
}

/**
 * `git diff --numstat` → per-file added/removed counts.
 *
 * A binary file's counts are `-`, which becomes 0 here: the file is still reported
 * as changed, which is the fact `stat` exists to carry. `stripPrefix` re-anchors the
 * host-repo case, whose paths arrive repo-relative, onto the app directory — so both
 * bases report the same app-relative paths, and either can be fed straight back in
 * as `paths`.
 */
function parseNumstat(
  stdout: string,
  stripPrefix?: string,
): { file: string; added: number; removed: number }[] {
  const rows: { file: string; added: number; removed: number }[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split('\t');
    let file = rest.join('\t');
    if (!file) continue;
    if (stripPrefix && file.startsWith(`${stripPrefix}/`)) {
      file = file.slice(stripPrefix.length + 1);
    }
    rows.push({ file, added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return rows;
}

export interface RestoreResult {
  success: true;
  appId: string;
  ref: string;
  /** Files the restore changed on disk. */
  files: string[];
  /** Whether dist/ was rebuilt from the restored source. */
  recompiled: boolean;
  /** Set when the source restored but recompiling it failed. */
  compileError?: string;
}

/**
 * Roll an app's directory back to an earlier commit.
 *
 * History stays append-only: the current state is snapshotted first (so the
 * restore is itself undoable) and the rollback lands as a *new* commit rather
 * than by moving HEAD. `read-tree -u --reset` is what makes this a true restore
 * — it deletes files added since `ref`, which `checkout -- .` would leave behind.
 *
 * `dist/` is excluded from history, so restoring source leaves a stale build:
 * recompile afterwards or the running app still serves the old code.
 */
export async function restoreApp(appId: string, ref: string): Promise<RestoreResult | GitFailure> {
  const dir = appDirOrError(appId);
  if ('success' in dir) return dir;

  if (!isValidRef(ref)) {
    return { success: false, error: `Invalid ref "${ref}". Use a commit hash or HEAD~N.` };
  }

  const initErr = await ensureRepo(appId, dir.path);
  if (initErr) return initErr;

  const env = shadowEnv(appId, dir.path);

  const resolved = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], env, dir.path);
  if (!resolved.ok) {
    return { success: false, error: `No such commit "${ref}" in ${appId}'s history.` };
  }
  const target = resolved.stdout.trim();

  // Snapshot the current state first — restoring must never be the step that
  // loses work. A no-op when the tree is already clean, which is the common case:
  // HEAD then *is* the pre-restore state, and history is append-only, so it stays
  // reachable either way.
  await snapshotApp(appId, `checkpoint: before restore to ${target.slice(0, 7)}`);

  const changed = await runGit(['diff', '--name-only', target], env, dir.path);

  const restore = await runGit(['read-tree', '-u', '--reset', target], env, dir.path);
  if (!restore.ok) {
    return { success: false, error: `Failed to restore "${appId}": ${restore.stderr}` };
  }

  const commitErr = await commitAll(appId, dir.path, `restore: ${appId} to ${target.slice(0, 7)}`);
  if (commitErr) return commitErr;

  const files = changed.ok ? changed.stdout.split('\n').filter(Boolean) : [];

  // Restored source without a matching build means the app keeps serving the old
  // code — rebuild dist/ so the rollback is actually live.
  let recompiled = false;
  let compileError: string | undefined;
  if (existsSync(join(dir.path, 'src', 'main.ts'))) {
    try {
      const { compileTypeScript } = await import('@yaar/compiler');
      let bundles: string[] | undefined;
      let title = appId;
      try {
        const meta = JSON.parse(await Bun.file(join(dir.path, 'app.json')).text());
        if (Array.isArray(meta.bundles)) bundles = meta.bundles;
        if (typeof meta.name === 'string') title = meta.name;
      } catch {
        /* no app.json */
      }
      const result = await compileTypeScript(dir.path, { title, bundles });
      if (result.success) recompiled = true;
      else compileError = result.errors?.join('\n') ?? 'Unknown compile error';
    } catch (err) {
      compileError = err instanceof Error ? err.message : 'Unknown compile error';
    }
  }

  const { actionEmitter } = await import('../../session/action-emitter.js');
  actionEmitter.emitAction({ type: 'desktop.refreshApps' });

  return {
    success: true,
    appId,
    ref: target,
    files,
    recompiled,
    ...(compileError && { compileError }),
  };
}
