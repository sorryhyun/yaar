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
 * This runs as a Bun `--preload` (wired in scripts/run-unit-tests.ts), which is
 * awaited before any test file is imported. That ordering is load-bearing:
 * `listApps()` keeps a short TTL cache, so the *first* caller in the shared
 * `--parallel` process fixes the manifest every other file sees. A per-file
 * `beforeAll` cannot guarantee it writes first; a preload can. Regenerating from
 * source via the compiler's own extractor (available because CI builds the
 * compiler) means the fixture agrees with what a real build would emit.
 *
 * Idempotent and disk-truth-only: it writes nothing when the artifact already
 * exists, so a normal built tree — local dev, a bundled exe — is untouched.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractProtocolFromDir } from '@yaar/compiler';
import { resolveAppDir } from '../../features/apps/roots.js';

/** Apps whose protocol manifest a unit test reads. Add an id when a test needs it. */
const APPS_UNDER_TEST = ['dock', 'devtools'] as const;

async function ensureProtocol(appId: string): Promise<void> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return; // app absent (e.g. trimmed build) — let the test report it
  const distProtocol = join(appDir, 'dist', 'protocol.json');
  if (await Bun.file(distProtocol).exists()) return;

  const { protocol } = await extractProtocolFromDir(join(appDir, 'src'));
  if (!protocol) return; // no protocol declared — nothing to materialize
  await mkdir(join(appDir, 'dist'), { recursive: true });
  await Bun.write(distProtocol, JSON.stringify(protocol, null, 2));
}

await Promise.all(APPS_UNDER_TEST.map(ensureProtocol));
