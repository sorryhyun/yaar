import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * `defineCommand` has no runtime behaviour to test — it is an identity function.
 * Its entire value is the type-level derivation of a handler's parameter from the
 * `params` JSON Schema, which nothing else in the suite would notice breaking.
 *
 * So these tests run the real `tsc` over fixture sources and assert on the
 * diagnostics. They are slower than the rest of the suite by design: a cheaper test
 * here would not test the thing.
 *
 * The compiler options mirror `typecheckSandbox` (notably `strict: false`) so a
 * fixture that passes here passes for a real app. `tsc` is driven through Bun rather
 * than its node-shebang bin script, so the suite does not require a node install.
 */

const BUNDLED_TYPES = resolve(import.meta.dir, 'bundled-types');
const TSC_JS = resolve(import.meta.dir, '../node_modules/typescript/lib/tsc.js');

let sandbox: string;

// These tests launch tsc, and the enum case launches it twice. Leave enough
// headroom when workspace test suites are running in parallel on slower hosts.
setDefaultTimeout(15_000);

/** Typecheck `source` as an app's `src/main.ts` and return tsc's diagnostics. */
async function check(source: string): Promise<string[]> {
  await Bun.write(join(sandbox, 'src', 'main.ts'), source);
  const tsconfigPath = join(sandbox, 'tsconfig.json');
  await Bun.write(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        strict: false,
        noEmit: true,
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        paths: { '@bundled/*': [join(BUNDLED_TYPES, '*')] },
        skipLibCheck: true,
      },
      files: [join(BUNDLED_TYPES, 'index.d.ts')],
      include: ['src/**/*.ts'],
    }),
  );

  const proc = Bun.spawn([process.execPath, TSC_JS, '--noEmit', '-p', tsconfigPath], {
    cwd: sandbox,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-define-command-'));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('defineCommand type inference', () => {
  test('infers primitives, enums, arrays, nested objects and optionality', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Everything at once',
        params: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            title: { type: 'string' },
            force: { type: 'boolean' },
            count: { type: 'integer' },
            tabIds: { type: 'array', items: { type: 'number' } },
            mode: { enum: ['fast', 'slow'] },
            nested: {
              type: 'object',
              properties: { deep: { type: 'boolean' } },
              required: ['deep'],
            },
          },
          required: ['tabId'],
        },
        handler: (p) => {
          const tabId: number = p.tabId;
          const title: string = p.title;
          const force: boolean = p.force;
          const count: number = p.count;
          const tabIds: number[] = p.tabIds;
          const mode: 'fast' | 'slow' = p.mode;
          const deep: boolean = p.nested.deep;
          return [tabId, title, force, count, tabIds, mode, deep];
        },
      });
    `);
    expect(diagnostics).toEqual([]);
  });

  test('a misspelled parameter key is a compile error', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Focus a tab',
        params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
        handler: (p) => p.tabld,
      });
    `);
    expect(diagnostics.join('\n')).toContain("Property 'tabld' does not exist");
  });

  test('a parameter used at the wrong type is a compile error', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Focus a tab',
        params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
        handler: (p) => { const s: string = p.tabId; return s; },
      });
    `);
    expect(diagnostics.join('\n')).toContain('Type');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  test('an enum becomes a literal union: widening is fine, narrowing is an error', async () => {
    const widened = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Set mode',
        params: { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } }, required: ['mode'] },
        handler: (p) => { const m: 'fast' | 'slow' | 'medium' = p.mode; return m; },
      });
    `);
    expect(widened).toEqual([]);

    const narrowed = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Set mode',
        params: { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } }, required: ['mode'] },
        handler: (p) => { const m: 'fast' = p.mode; return m; },
      });
    `);
    expect(narrowed.join('\n')).toContain('not assignable to type \'"fast"\'');
  });

  test('additionalProperties describes a dictionary', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Set cells',
        params: {
          type: 'object',
          properties: {
            cells: { type: 'object', additionalProperties: { type: 'string' } },
            counts: { type: 'object', additionalProperties: { type: 'number' } },
            loose: { type: 'object' },
          },
          required: ['cells'],
        },
        handler: (p) => {
          const cells: Record<string, string> = p.cells;
          const counts: Record<string, number> = p.counts;
          const loose: Record<string, unknown> = p.loose;
          return [cells, counts, loose];
        },
      });
    `);
    expect(diagnostics).toEqual([]);
  });

  test('the parameterless overload accepts a nullary handler', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({ description: 'Refresh', handler: () => 1 });
    `);
    expect(diagnostics).toEqual([]);
  });

  test('an unsupported keyword degrades to unknown rather than a wrong type', async () => {
    const diagnostics = await check(`
      import { defineCommand } from '@bundled/yaar';
      export const cmd = defineCommand({
        description: 'Union param',
        params: {
          type: 'object',
          properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          required: ['value'],
        },
        handler: (p) => { const v: unknown = p.value; return v; },
      });
    `);
    expect(diagnostics).toEqual([]);
  });
});
