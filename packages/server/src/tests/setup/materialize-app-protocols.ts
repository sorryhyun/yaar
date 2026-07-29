/**
 * Test preload — materializes `dist/protocol.json` for apps whose protocol a test
 * asserts on, before any test file in the process loads.
 *
 * `buildAppAgentProfile` reads an app's `appStateKeys` from its built
 * `dist/protocol.json`. CI builds `@yaar/shared` and `@yaar/compiler` but never
 * the apps, so that artifact is absent there and the manifest reads back empty —
 * a green local run (dist present) and a red CI (`app-agent-model.test.ts`
 * asserting `[]`).
 *
 * This runs as a Bun `[test] preload` (packages/server/bunfig.toml), so every
 * `bun test` in this package — the unit runner's spawned processes, the loopback
 * suite, the integration suite — runs it, awaited, before any test file is
 * imported. Two things make that ordering load-bearing:
 *   - `listApps()` keeps a short TTL cache, so the manifest the *first* caller
 *     sees is the one every later reader in that process gets. A per-file
 *     `beforeAll` cannot guarantee it writes first (another file in the shared
 *     `--parallel` process may cache the empty manifest); a preload, awaited
 *     before any test loads, can. Each process self-provisions before its own
 *     tests, so it never depends on another process having written first.
 * Regenerating from source via the compiler's own extractor (available because
 * CI builds the compiler) means the fixture agrees with what a real build emits.
 *
 * Idempotent and disk-truth-only: it writes nothing when the artifact already
 * exists, so a normal built tree — local dev, a bundled exe — is untouched. The
 * write is atomic (temp + rename) because the unit runner starts many processes
 * at once, and several may materialize the same missing file concurrently; a
 * rename means a reader sees the whole file or none of it, never a partial one.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractProtocolFromDir } from '@yaar/compiler';
import { resolveAppDir } from '../../features/apps/roots.js';

/** Apps whose protocol manifest a test reads. Add an id when a test needs it. */
const APPS_UNDER_TEST = ['dock', 'devtools', 'memo'] as const;

async function ensureProtocol(appId: string): Promise<void> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return; // app absent (e.g. trimmed build) — let the test report it
  const distProtocol = join(appDir, 'dist', 'protocol.json');
  if (await Bun.file(distProtocol).exists()) return;

  const { protocol } = await extractProtocolFromDir(join(appDir, 'src'));
  if (!protocol) return; // no protocol declared — nothing to materialize
  await mkdir(join(appDir, 'dist'), { recursive: true });
  const tmp = `${distProtocol}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify(protocol, null, 2));
    await rename(tmp, distProtocol);
  } catch (err) {
    // Writing the artifact is a best effort, never fatal. A preload that throws takes
    // its entire test process with it — one CI run lost the whole `units` partition to
    // an ENOENT renaming this temp file, and every test in it was reported as an error
    // rather than a result. The mechanism is unconfirmed (17 processes materialize the
    // same three files at once, which is the only concurrency here), so the response is
    // to check the outcome rather than the cause: if the file is there, someone else
    // wrote it and there was nothing left to do; if it is not, say so and let the test
    // that needs it fail on its own assertion.
    await rm(tmp, { force: true });
    if (await Bun.file(distProtocol).exists()) return;
    console.warn(`[test-preload] could not materialize ${appId}/dist/protocol.json:`, err);
  }
}

await Promise.all(APPS_UNDER_TEST.map(ensureProtocol));
