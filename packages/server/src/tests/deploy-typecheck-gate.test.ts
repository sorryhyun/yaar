/**
 * A deploy type checks the code it is about to ship.
 *
 * Bundling does not type check — Bun strips types and builds happily around them — so
 * "compile succeeded" never implied "this type checks", and every door between a broken
 * type and a live app was open: devtools' compile reported success, and deploy asked
 * nothing. The check has to live in the deploy itself, because that is the one door every
 * caller walks through.
 *
 * The gate returns before anything is written, so these tests never touch apps/.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '@yaar/compiler';
import { doDeploy } from '../features/dev/deploy.js';

// Each case shells out to tsc, as the real gate does.
setDefaultTimeout(20_000);

// The server does this at boot (lifecycle.ts); the gate shells out to the project's tsc.
beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string;

/** A sandbox holding one source file, as devtools' project layout would. */
async function writeSource(source: string): Promise<void> {
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await writeFile(join(sandbox, 'src', 'main.ts'), source);
  await writeFile(join(sandbox, 'app.json'), JSON.stringify({ name: 'Gate Test' }));
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-deploy-gate-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('deploy type-check gate', () => {
  it('refuses to ship code that does not type check', async () => {
    await writeSource(`const n: number = 'not a number';\nexport {};\n`);

    const result = await doDeploy('gate-test', {
      appId: 'gate-test',
      sourcePath: sandbox,
    });

    expect(result.success).toBe(false);
    // The refusal has to say what is wrong and how to override it, or it just reads as
    // a broken deploy.
    const error = (result as { error: string }).error;
    expect(error).toContain('Type check failed');
    expect(error).toContain('skipTypecheck');
  });

  it('names the offending line, rather than just refusing', async () => {
    await writeSource(`const n: number = 'not a number';\nexport {};\n`);

    const result = await doDeploy('gate-test', { appId: 'gate-test', sourcePath: sandbox });

    expect((result as { error: string }).error).toMatch(/main\.ts/);
  });

  it('lets a caller past the gate when it says so on purpose', async () => {
    // Type-broken source, and no entry point — so the deploy clears the gate and then stops
    // at the next check ("nothing to deploy") without writing anything. The assertion is
    // about which door stopped it: with skipTypecheck, no longer the type checker.
    await mkdir(join(sandbox, 'src'), { recursive: true });
    await writeFile(join(sandbox, 'src', 'helper.ts'), `const n: number = 'nope';\nexport {};\n`);

    const result = await doDeploy('gate-test', {
      appId: 'gate-test',
      sourcePath: sandbox,
      skipTypecheck: true,
    });

    expect(result.success).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).not.toContain('Type check failed');
    expect(error).toContain('Nothing to deploy');
  });
});
