#!/usr/bin/env bun
/**
 * Prepare a release on `dev`: stamp the version everywhere, refresh the OpenAPI
 * spec, and print the remaining steps.
 *
 * Usage: bun run release:prepare v0.12.2
 *
 * Why a local script and not a workflow: the version commit must be a commit CI
 * has actually seen. A workflow pushing it with GITHUB_TOKEN does not trigger
 * workflows, so the commit would arrive carrying no `ci / check` status and the
 * `main` ruleset would reject it — and the Actions bot cannot be granted a
 * ruleset bypass on a user-owned repo (GitHub allows that actor only for
 * org-owned repositories). So the bump rides the normal dev -> main path like
 * any other change, and `release.yml` asserts it actually happened.
 *
 * Leaves the edits staged-but-uncommitted on purpose: the commit message and the
 * decision to push are yours.
 */

import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: bun run release:prepare <version>   (e.g. v0.12.2)');
  process.exit(1);
}
const version = raw.replace(/^v/, '');

/** Run a command at the repo root, streaming its output. Exits on failure. */
function run(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) {
    console.error(`[release:prepare] \`${cmd.join(' ')}\` failed`);
    process.exit(proc.exitCode ?? 1);
  }
}

/** Captured stdout of a command, trimmed. */
function capture(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return proc.stdout.toString().trim();
}

// A dirty tree makes the bump indistinguishable from whatever else is in flight,
// and the whole point is a commit that contains only the version.
if (capture(['git', 'status', '--porcelain']) !== '') {
  console.error('[release:prepare] Working tree is not clean. Commit or stash first.');
  process.exit(1);
}

const branch = capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'dev') {
  console.error(`[release:prepare] On "${branch}", expected "dev".`);
  console.error('The bump is promoted to main through the normal dev -> main path.');
  process.exit(1);
}

run(['bun', 'run', 'set-version', version]);
run(['bun', 'run', 'generate:openapi']);

if (capture(['git', 'status', '--porcelain']) === '') {
  console.log(`\nAlready at ${version}; nothing to commit.`);
  process.exit(0);
}

run(['git', 'add', '-A']);

console.log(`
Staged the bump to ${version}:

${capture(['git', 'diff', '--cached', '--stat'])}

Next:
  git commit -m "chore(release): set version to ${version}"
  git push origin dev                     # CI runs -> the commit gets its ci / check
  # once green:
  git push origin dev:main                # fast-forward promotion
  gh release create v${version} --target main --draft --generate-notes
  # review the notes, then Publish -> release.yml verifies and builds the artifacts
`);
