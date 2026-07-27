/**
 * The persisted `remote` preference → `IS_REMOTE`.
 *
 * The configurations app writes `remote: true` into `config/settings.json` and
 * `loadPersistedRemote()` applies it at module load. It's a boot-time side effect with no
 * return value, so nothing else in the suite covers it.
 *
 * Each case runs in its own process: `IS_REMOTE` is a module-load constant, so importing
 * `config/env.js` here would freeze it for the whole file. The child's env is built from
 * scratch so a `REMOTE` in the developer's shell can't decide the result.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENV_MODULE = join(import.meta.dir, '..', 'config', 'env.ts');

/**
 * Read `IS_REMOTE` out of a fresh process, with `configDir` as YAAR_CONFIG and
 * `remoteEnv` as the `REMOTE` variable (omit for unset).
 */
async function readIsRemote(configDir: string, remoteEnv?: string): Promise<boolean> {
  const script = `
    const { IS_REMOTE } = await import(${JSON.stringify(Bun.pathToFileURL(ENV_MODULE).href)});
    console.log(IS_REMOTE ? 'remote' : 'local');
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    // A bare env — PATH so `bun` resolves, and nothing that could smuggle REMOTE in.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YAAR_CONFIG: configDir,
      ...(remoteEnv === undefined ? {} : { REMOTE: remoteEnv }),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`env.ts import failed (${exitCode}): ${stderr}`);
  return stdout.trim() === 'remote';
}

/** Run `fn` against a throwaway config dir holding `settings.json` (omit for no file). */
async function withSettings<T>(
  contents: string | null,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'yaar-settings-'));
  try {
    if (contents !== null) writeFileSync(join(dir, 'settings.json'), contents);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('persisted remote preference', () => {
  test('no settings.json → local', async () => {
    expect(await withSettings(null, readIsRemote)).toBe(false);
  });

  test('remote: true → remote mode, with no env var set', async () => {
    expect(await withSettings('{"remote":true}', readIsRemote)).toBe(true);
  });

  test('remote: false → local', async () => {
    expect(await withSettings('{"remote":false}', readIsRemote)).toBe(false);
  });

  // The env var is the per-run override, and has to win in both directions.
  test('REMOTE=1 wins over remote: false', async () => {
    expect(await withSettings('{"remote":false}', (d) => readIsRemote(d, '1'))).toBe(true);
  });

  test('REMOTE=0 wins over remote: true', async () => {
    expect(await withSettings('{"remote":true}', (d) => readIsRemote(d, '0'))).toBe(false);
  });

  test('malformed settings.json → local, no crash', async () => {
    expect(await withSettings('{ not json', readIsRemote)).toBe(false);
  });
});
