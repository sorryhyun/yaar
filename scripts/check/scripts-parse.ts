/**
 * Parse every file under `scripts/` and fail on anything that won't load.
 *
 * `scripts/` is the one tree with no compiler behind it: `bun run typecheck` and
 * `bun run lint` are both per-package (`bun run --filter '*'`), and every package
 * lints `src`, so nothing in this directory is ever read by a tool until the
 * moment CI executes it. Most of it runs on every push and so is checked by
 * being used — but the build scripts run *only* in `release.yml`, on a commit
 * that is already tagged. `v0.13.0` failed there on a duplicate `const args` in
 * `scripts/build/exe-bundle.js`: a scope error a parser sees instantly, found
 * instead by shipping a tag and watching the Windows build die.
 *
 * `Bun.Transpiler` is the same front end `bun run` uses, so "this parses" here
 * means "this at least starts" there. It is a syntax and scope check only —
 * types, imports, and runtime behavior are still nobody's job in this tree.
 *
 * Usage:
 *   bun run scripts/check/scripts-parse.ts
 *
 * Exit code: 1 if any file fails to parse.
 */

import { readFileSync } from 'fs';
import { Glob } from 'bun';
import { relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  js: new Bun.Transpiler({ loader: 'js' }),
};

const failures: string[] = [];
let checked = 0;

for (const rel of new Glob('**/*.{ts,js,mjs}').scanSync({ cwd: SCRIPTS_DIR })) {
  const absolute = resolve(SCRIPTS_DIR, rel);
  const transpiler = rel.endsWith('.ts') ? transpilers.ts : transpilers.js;
  checked++;
  try {
    transpiler.transformSync(readFileSync(absolute, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${relative(REPO_ROOT, absolute)}: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(`[check:scripts] ${failures.length} file(s) failed to parse:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[check:scripts] ${checked} files parse`);
