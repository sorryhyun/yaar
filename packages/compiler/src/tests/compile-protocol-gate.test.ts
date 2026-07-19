/**
 * A compile refuses to ship a truncated protocol manifest.
 *
 * The extractor stops at the first entry it cannot parse (a spread, a computed
 * key) and silently drops everything after it — dist/protocol.json shrinks
 * while the bundle builds green and the app runs fine. The gate turns those
 * partial parses into a failed compile; a clean register() is unaffected, and
 * so is an app with no register() at all.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';

// Each case pays for a real Bun.build().
setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({
    projectRoot: resolve(import.meta.dir, '../../../..'),
    isBundledExe: false,
  });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

async function compileSource(source: string) {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-protocol-gate-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), source);
  return compileTypeScript(sandbox, { title: 'Gate Test' });
}

// A local stand-in for app.register — the extractor only pattern-matches
// `.register({`, and a @bundled import would drag the whole SDK into the test.
const PRELUDE = `
const app = { register(_config: unknown): void {} };
const sharedCommands = { extra: { description: 'Extra', handler: () => 0 } };
void sharedCommands;
`;

const CHOKED = `${PRELUDE}
app.register({
  appId: 'demo',
  name: 'Demo',
  commands: {
    first: { description: 'First', handler: () => 1 },
    ...sharedCommands,
    third: { description: 'Third', handler: () => 3 },
  },
});
export {};
`;

const CLEAN = `${PRELUDE}
app.register({
  appId: 'demo',
  name: 'Demo',
  state: {
    status: { description: 'Status', handler: () => 'ok' },
  },
  commands: {
    first: { description: 'First', handler: () => 1 },
    third: { description: 'Third', handler: () => 3 },
  },
});
export {};
`;

describe('compile protocol gate', () => {
  test('fails the build when a commands spread chokes extraction', async () => {
    const result = await compileSource(CHOKED);

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('spread');
    expect(errors).toContain('commands');
    // The refusal must say how to fix it, or it just reads as a broken build.
    expect(errors).toContain('defineCommand');
    expect(result.protocolWarnings?.length).toBeGreaterThan(0);

    // The truncated manifest must not have been written.
    expect(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).exists()).toBe(false);
  });

  test('a clean register() compiles and reports the manifest summary', async () => {
    const result = await compileSource(CLEAN);

    expect(result.success).toBe(true);
    expect(result.protocol).toEqual({ commands: ['first', 'third'], state: ['status'] });
    expect(result.protocolWarnings).toBeUndefined();

    const written = JSON.parse(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).text());
    expect(Object.keys(written.commands)).toEqual(['first', 'third']);
  });

  test('no register() call compiles with no protocol summary', async () => {
    const result = await compileSource(`document.title = 'plain';\nexport {};\n`);

    expect(result.success).toBe(true);
    expect(result.protocol).toBeUndefined();
    expect(result.protocolWarnings).toBeUndefined();
  });
});
