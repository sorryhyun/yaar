/**
 * Test-environment isolation — the first `[test] preload` of every package in this repo.
 *
 * A test run must describe the *code*, not the machine it runs on. It did not: the server
 * resolves its mode at module load from two things a developer owns — `config/settings.json`
 * (`loadPersistedRemote()` in `config/env.ts`) and the root `.env` (`loadRootEnv()`) — so a
 * developer who had toggled remote mode on in the configurations app got `REMOTE=1` inside
 * `bun test`, and with it token auth, remote CORS, and `isAppOriginIsolationEnabled() === false`.
 * Suites written against local mode then failed on that machine and passed in CI, which has
 * neither file. `http-routing.test.ts` and `app-origin-isolation.test.ts` were the casualties.
 *
 * So this preload owns the environment instead of inheriting it. It runs before any test file
 * — and therefore before `config/env.ts` is imported and freezes `IS_REMOTE` — and:
 *
 *   1. scrubs every `YAAR_*` var plus the documented non-prefixed knobs (CLAUDE.md), so a
 *      shell export cannot decide an assertion either;
 *   2. pins `REMOTE` explicitly. Explicit is what matters: `loadPersistedRemote()` only fills
 *      in when `REMOTE` is *unset*, so writing `'0'` here is what makes settings.json inert;
 *   3. points `YAAR_CONFIG` / `YAAR_STORAGE` at fresh temp dirs, so nothing reads the
 *      developer's saved permissions, hooks, or mounts — and nothing a test writes lands in
 *      the working tree;
 *   4. sets `YAAR_SKIP_DOTENV`, the one seam `loadRootEnv()` honours, so the root `.env`
 *      cannot reintroduce a knob behind all of the above.
 *
 * `YAAR_TEST_REMOTE=1` is the single opt-in for a remote-mode process (`YAAR_TEST_*` is the
 * runner's control channel and survives the scrub). `IS_REMOTE` is a module-load constant, so
 * remote mode can only ever be a *whole process*: see `packages/server/src/tests/remote/`,
 * which the server's test script runs that way — and which this file also infers, so that
 * running one of those files by path is not silently the same as running it in local mode.
 *
 * Deliberately imports nothing from the workspace — it must be safe to load before anything
 * else, from any package's bunfig.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runner-owned vars, exempt from the scrub — they are how a suite asks for a mode. */
const CONTROL_PREFIX = 'YAAR_TEST_';

/**
 * Behaviour-changing vars without the `YAAR_` prefix (the environment table in CLAUDE.md
 * and packages/server/CLAUDE.md). Everything here has a defined default in `config/`;
 * removing it is what makes that default the one under test.
 */
const SCRUBBED = [
  'REMOTE',
  'PORT',
  'PROVIDER',
  'MAX_AGENTS',
  'MCP_SKIP_AUTH',
  'MONITOR_MAX_CONCURRENT',
  'MONITOR_MAX_ACTIONS_PER_MIN',
  'MONITOR_MAX_OUTPUT_PER_MIN',
  'CODEX_WS_PORT',
  'CHROME_PATH',
  'CHROME_DEBUG_PORT',
  'LAUNCH_CHROME',
  'MARKET_URL',
  'FRONTEND_DIST',
  'GOOGLE_CLIENT_ID',
];

for (const key of Object.keys(process.env)) {
  if (key.startsWith('YAAR_') && !key.startsWith(CONTROL_PREFIX)) delete process.env[key];
}
for (const key of SCRUBBED) delete process.env[key];

const tempDirs: string[] = [];
function scratchDir(kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yaar-test-${kind}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * A `tests/remote/` directory *is* the opt-in — the env var is how it is carried, not a second
 * way to ask.
 *
 * Those files are only meaningful under `REMOTE=1`, and the test script that runs them sets it
 * explicitly. Anyone running one by path — `bun test packages/server/src/tests/remote/…`, which
 * is what a developer reaches for after a red CI line — got a local-mode process instead, where
 * `checkHttpAuth` returns `null` on its first line. Inferring it from the location means the
 * directory carries the requirement, so a file placed there cannot be run the wrong way by
 * accident, and a new remote suite needs no runner change.
 *
 * `Bun.main` is the first test file the runner collected. A run that *mixes* remote files with
 * others is a different problem and is not this file's to solve — `scripts/test/partition-guard.ts`
 * refuses it outright.
 */
if (/\/tests\/remote\//.test((Bun.main ?? '').replaceAll('\\', '/'))) {
  process.env.YAAR_TEST_REMOTE = '1';
}

process.env.YAAR_SKIP_DOTENV = '1';
process.env.REMOTE = process.env.YAAR_TEST_REMOTE === '1' ? '1' : '0';
process.env.YAAR_CONFIG = scratchDir('config');
process.env.YAAR_STORAGE = scratchDir('storage');

// One process, one pair of dirs — removed on the way out. `exit` (not a signal handler) so a
// suite that is killed mid-run leaves them in the OS temp dir rather than half-deleted under
// a still-running test.
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
