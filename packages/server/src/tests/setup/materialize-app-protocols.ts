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

import { mkdir, rename } from 'node:fs/promises';
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
  await Bun.write(tmp, JSON.stringify(protocol, null, 2));
  await rename(tmp, distProtocol);
}

await Promise.all(APPS_UNDER_TEST.map(ensureProtocol));
