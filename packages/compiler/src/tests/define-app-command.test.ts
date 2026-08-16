import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createTypecheckBatch } from './helpers/typecheck-batch.js';

/**
 * `defineAppCommand` has no runtime behaviour to test — it is an identity
 * function. Its entire value is the type-level derivation of `run`'s parameter
 * from the `params` JSON Schema, which nothing else in the suite would notice
 * breaking. (The same `YaarInferSchema` engine types every command written
 * inline in a `defineApp({...})` literal, so this is where that engine is
 * pinned.)
 *
 * So these tests run the real `tsc` over fixture sources and assert on the
 * diagnostics. A cheaper test here would not test the thing.
 *
 * Every fixture below shares one `tsc` run, and `fixture()` therefore has to be called
 * while this file is being collected rather than from inside a test body — see
 * `helpers/typecheck-batch.ts` for what that buys (this file was ~27s of a ~66s package
 * suite) and how the rule is enforced.
 */

const batch = createTypecheckBatch('define-app-command');
const { fixture } = batch;

// One tsc run for the whole file. Leave enough headroom for a loaded CI host.
setDefaultTimeout(30_000);

beforeAll(() => batch.run());
afterAll(() => batch.cleanup());

describe('defineAppCommand type inference', () => {
  const everything = fixture(
    'everything-at-once',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
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
        run: (p) => {
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
    `,
  );
  test('infers primitives, enums, arrays, nested objects and optionality', () => {
    expect(everything()).toEqual([]);
  });

  const misspelledKey = fixture(
    'misspelled-key',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
        description: 'Focus a tab',
        params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
        run: (p) => p.tabld,
      });
    `,
  );
  test('a misspelled parameter key is a compile error', () => {
    expect(misspelledKey().join('\n')).toContain("Property 'tabld' does not exist");
  });

  const wrongType = fixture(
    'wrong-type',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
        description: 'Focus a tab',
        params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
        run: (p) => { const s: string = p.tabId; return s; },
      });
    `,
  );
  test('a parameter used at the wrong type is a compile error', () => {
    expect(wrongType().join('\n')).toContain('Type');
    expect(wrongType().length).toBeGreaterThan(0);
  });

  const enumWidened = fixture(
    'enum-widened',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
        description: 'Set mode',
        params: { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } }, required: ['mode'] },
        run: (p) => { const m: 'fast' | 'slow' | 'medium' = p.mode; return m; },
      });
    `,
  );
  const enumNarrowed = fixture(
    'enum-narrowed',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
        description: 'Set mode',
        params: { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } }, required: ['mode'] },
        run: (p) => { const m: 'fast' = p.mode; return m; },
      });
    `,
  );
  test('an enum becomes a literal union: widening is fine, narrowing is an error', () => {
    expect(enumWidened()).toEqual([]);
    expect(enumNarrowed().join('\n')).toContain('not assignable to type \'"fast"\'');
  });

  const dictionary = fixture(
    'additional-properties',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
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
        run: (p) => {
          const cells: Record<string, string> = p.cells;
          const counts: Record<string, number> = p.counts;
          const loose: Record<string, unknown> = p.loose;
          return [cells, counts, loose];
        },
      });
    `,
  );
  test('additionalProperties describes a dictionary', () => {
    expect(dictionary()).toEqual([]);
  });

  const nullary = fixture(
    'no-params',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({ description: 'Refresh', run: () => 1 });
    `,
  );
  test('a command with no params accepts a nullary run', () => {
    expect(nullary()).toEqual([]);
  });

  const unsupported = fixture(
    'unsupported-keyword',
    `
      import { defineAppCommand } from '@bundled/yaar';
      export const cmd = defineAppCommand({
        description: 'Union param',
        params: {
          type: 'object',
          properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          required: ['value'],
        },
        run: (p) => { const v: unknown = p.value; return v; },
      });
    `,
  );
  test('an unsupported keyword degrades to unknown rather than a wrong type', () => {
    expect(unsupported()).toEqual([]);
  });
});

describe('appStorage types', () => {
  const listShape = fixture(
    'storage-list-shape',
    `
      import { appStorage } from '@bundled/yaar';
      async function inspect() {
        const entries = await appStorage.list('projects/');
        const path: string = entries[0].path;
        const isDirectory: boolean = entries[0].isDirectory;
        const uri: string = entries[0].uri;
        const mimeType: string | undefined = entries[0].mimeType;
        return { path, isDirectory, uri, mimeType };
      }
    `,
  );
  test('list exposes the app-scoped storage entry shape', () => {
    expect(listShape()).toEqual([]);
  });

  // The rule this test enforces has not changed: the type promises exactly what the
  // wire delivers, no more. What changed is the wire — `size` and `modifiedAt` now
  // ride on the resource links a storage listing returns, so declaring them is the
  // accurate half of that rule rather than a violation of it. Both are optional,
  // because a directory has no size and an older server sends neither.
  const listMetadata = fixture(
    'storage-list-metadata',
    `
      import { appStorage } from '@bundled/yaar';
      async function inspect() {
        const entries = await appStorage.list();
        const size: number | undefined = entries[0].size;
        const modifiedAt: string | undefined = entries[0].modifiedAt;
        return { size, modifiedAt };
      }
    `,
  );
  test('list entries expose the metadata the listing actually carries', () => {
    expect(listMetadata()).toEqual([]);
  });

  const listOverclaim = fixture(
    'storage-list-overclaim',
    `
      import { appStorage } from '@bundled/yaar';
      async function inspect() {
        const entries = await appStorage.list();
        return entries[0].createdAt;
      }
    `,
  );
  test('list entries still do not claim fields the listing never sends', () => {
    expect(listOverclaim().join('\n')).toContain("Property 'createdAt' does not exist");
  });
});
