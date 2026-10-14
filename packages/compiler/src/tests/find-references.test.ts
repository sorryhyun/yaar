import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { disposeReferencesWorker, findReferences, typeAt } from '../references/index.js';
import type {
  FindReferencesQuery,
  FindReferencesResult,
  TypeAtQuery,
} from '../references/types.js';

setDefaultTimeout(30_000);

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..');

const MODEL = `
import { createSignal } from '@bundled/solid-js';

export class Store {
  save() {
    return 1;
  }
}

export function setBlocks(blocks: string[]) {
  return blocks.length;
}

export const [count, setCount] = createSignal(0);
`;

const BARREL = `
export { setBlocks as applyBlocks, Store } from './model';
`;

const MAIN = `
import { errMsg } from '@bundled/yaar';
import { applyBlocks, Store as Doc } from './barrel';
import { setCount } from './model';

const doc = new Doc();

function defineAppCommand<T>(d: T): T {
  return d;
}

export const commands = {
  load: defineAppCommand({
    run: () => applyBlocks(['a']),
  }),
};

export function persist() {
  applyBlocks([]);
  doc.save();
  return errMsg(new Error('x'));
}

export function bump() {
  setCount(1);
  setCount(2);
}
`;

let sandbox: string;

async function find(
  query: FindReferencesQuery,
  bundles?: string[],
): Promise<Extract<FindReferencesResult, { success: true }>> {
  const result = await findReferences(sandbox, query, { bundles });
  if (!result.success) throw new Error(`${result.kind}: ${result.error}`);
  return result;
}

beforeAll(async () => {
  initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: false });
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-references-'));
  await mkdir(join(sandbox, 'src'));
  await Bun.write(join(sandbox, 'src', 'model.ts'), MODEL);
  await Bun.write(join(sandbox, 'src', 'barrel.ts'), BARREL);
  await Bun.write(join(sandbox, 'src', 'main.ts'), MAIN);
});

afterAll(async () => {
  disposeReferencesWorker();
  await rm(sandbox, { recursive: true, force: true });
});

describe('findReferences', () => {
  test('follows a renamed re-export to its call sites, with callers', async () => {
    const result = await find({ file: 'src/model.ts', symbol: 'setBlocks', callers: true });

    expect(result.symbol).toBe('setBlocks');
    expect(result.definitions).toEqual([
      { file: 'src/model.ts', line: 10, column: 17, name: 'setBlocks', kind: 'function' },
    ]);
    const calls = result.references.filter((r) => r.isCall);
    expect(calls.map((r) => [r.file, r.line, r.enclosing])).toEqual([
      ['src/main.ts', 14, 'commands.load.run'],
      ['src/main.ts', 19, 'persist'],
    ]);
    expect(result.references.find((r) => r.file === 'src/barrel.ts')?.role).toBe('export');

    expect(result.callersFrom).toBe('call-hierarchy');
    expect(result.callers?.map((c) => c.file)).toEqual(['src/main.ts', 'src/main.ts']);
    expect(result.callers?.flatMap((c) => c.calls.map((call) => call.line)).sort()).toEqual([
      14, 19,
    ]);
  });

  test('resolves Class.method through a class imported under another name', async () => {
    const result = await find({ file: 'src/model.ts', symbol: 'Store.save' });
    expect(result.at).toEqual({ file: 'src/model.ts', line: 5, column: 3 });
    expect(result.references.filter((r) => r.isCall)).toEqual([
      {
        file: 'src/main.ts',
        line: 20,
        column: 7,
        text: 'doc.save();',
        enclosing: 'persist',
        isCall: true,
      },
    ]);
  });

  test('derives callers from call sites when call hierarchy cannot start (signal setter)', async () => {
    const result = await find({ file: 'src/model.ts', symbol: 'setCount', callers: true });
    expect(result.callersFrom).toBe('references');
    expect(result.callers).toEqual([
      {
        caller: 'bump',
        kind: 'function',
        file: 'src/main.ts',
        line: 24,
        calls: [
          { line: 25, column: 3 },
          { line: 26, column: 3 },
        ],
      },
    ]);
    // An import binding is not a write, whatever the checker's flag says.
    const imported = result.references.find((r) => r.role === 'import');
    expect(imported?.isWrite).toBeUndefined();
  });

  test('line + column and line + symbol land on the same symbol', async () => {
    const byColumn = await find({ file: 'src/main.ts', line: 19, column: 3 });
    const bySymbol = await find({ file: 'src/main.ts', line: 19, symbol: 'applyBlocks' });
    expect(byColumn.symbol).toBe('applyBlocks');
    expect(bySymbol.references).toEqual(byColumn.references);
    expect(bySymbol.definitions[0]).toMatchObject({ file: 'src/model.ts', name: 'setBlocks' });
  });

  test('resolves @bundled members against the grant-sliced declarations', async () => {
    const result = await find({ file: 'src/main.ts', symbol: 'errMsg' });
    expect(result.definitions).toEqual([
      expect.objectContaining({ file: '@bundled-types/index.d.ts', name: 'errMsg' }),
    ]);

    // Same gate as typecheck: a gated SDK without its grant resolves to nothing.
    await Bun.write(
      join(sandbox, 'src', 'dev.ts'),
      `import { compile } from '@bundled/yaar-dev';\nexport const c = compile;\n`,
    );
    try {
      const granted = await find({ file: 'src/dev.ts', symbol: 'compile' }, ['yaar-dev']);
      expect(granted.definitions.map((d) => d.file)).toContain('@bundled-types/index.d.ts');
      const denied = await find({ file: 'src/dev.ts', symbol: 'compile' });
      expect(denied.definitions.map((d) => d.file)).not.toContain('@bundled-types/index.d.ts');
    } finally {
      await rm(join(sandbox, 'src', 'dev.ts'));
    }
  });

  test('a warm program sees files written between two queries', async () => {
    const before = await find({ file: 'src/model.ts', symbol: 'setBlocks' });
    await Bun.write(
      join(sandbox, 'src', 'extra.ts'),
      `import { setBlocks } from './model';\nexport const n = setBlocks([]);\n`,
    );
    try {
      const after = await find({ file: 'src/model.ts', symbol: 'setBlocks' });
      expect(after.totalReferences).toBe(before.totalReferences + 2);
      expect(after.files).toBe(before.files + 1);
    } finally {
      await rm(join(sandbox, 'src', 'extra.ts'));
    }
  });

  test('lists production references before tests, and counts the tests', async () => {
    // `src/aaa.test.ts` sorts ahead of every production file by path alone — the shape
    // that let a cap cut music-maker's only production caller of `importScore`.
    const testFile = join(sandbox, 'src', 'aaa.test.ts');
    await Bun.write(
      testFile,
      `import { setBlocks } from './model';\nsetBlocks([]);\nsetBlocks(['x']);\n`,
    );
    try {
      const all = await find({ file: 'src/model.ts', symbol: 'setBlocks' });
      expect(all.testReferences).toBe(3);
      const files = all.references.map((r) => r.file);
      expect(files.slice(-3)).toEqual(['src/aaa.test.ts', 'src/aaa.test.ts', 'src/aaa.test.ts']);
      expect(files.indexOf('src/aaa.test.ts')).toBe(all.totalReferences - 3);

      const clipped = await find({
        file: 'src/model.ts',
        symbol: 'setBlocks',
        maxResults: all.totalReferences - 3,
      });
      expect(clipped.references.some((r) => r.file === 'src/aaa.test.ts')).toBe(false);
      expect(clipped.truncated).toBe(true);

      const prodOnly = await find({
        file: 'src/model.ts',
        symbol: 'setBlocks',
        excludeTests: true,
      });
      expect(prodOnly.totalReferences).toBe(all.totalReferences - 3);
      expect(prodOnly.testReferences).toBe(0);
    } finally {
      await rm(testFile);
    }
  });

  test('clips to maxResults and says so', async () => {
    const result = await find({ file: 'src/model.ts', symbol: 'setBlocks', maxResults: 1 });
    expect(result.references).toHaveLength(1);
    expect(result.totalReferences).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
  });

  test('refuses what it cannot answer, by kind', async () => {
    const kindOf = async (query: FindReferencesQuery) => {
      const result = await findReferences(sandbox, query);
      return result.success ? 'success' : result.kind;
    };
    expect(await kindOf({ file: 'src/main.ts' })).toBe('invalid');
    expect(await kindOf({ file: 'src/main.ts', column: 3 } as FindReferencesQuery)).toBe('invalid');
    expect(await kindOf({ file: '../outside.ts', symbol: 'x' })).toBe('invalid');
    expect(await kindOf({ file: 'src/missing.ts', symbol: 'x' })).toBe('not-found');
    expect(await kindOf({ file: 'src/main.ts', symbol: 'nothingNamedThis' })).toBe('not-found');
    expect(await kindOf({ file: 'src/main.ts', line: 999, column: 1 })).toBe('invalid');
  });

  test('answers unavailable in the bundled exe rather than an empty success', async () => {
    initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: true });
    try {
      const result = await findReferences(sandbox, { file: 'src/main.ts', symbol: 'bump' });
      expect(result).toMatchObject({ success: false, kind: 'unavailable' });
    } finally {
      initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: false });
    }
  });
});

describe('typeAt', () => {
  const at = async (query: TypeAtQuery) => {
    const result = await typeAt(sandbox, query);
    if (!result.success) throw new Error(`${result.kind}: ${result.error}`);
    return result;
  };

  test('prints the declaration a hover would, by name or by position', async () => {
    const byName = await at({ file: 'src/model.ts', symbol: 'setBlocks' });
    expect(byName.kind).toBe('function');
    expect(byName.type).toBe('function setBlocks(blocks: string[]): number');

    // `doc` on line 6 of MAIN: `const doc = new Doc();`, column 7.
    const byPosition = await at({ file: 'src/main.ts', line: 6, column: 7 });
    expect(byPosition.symbol).toBe('doc');
    // The checker names the class by the local import alias, as a hover does.
    expect(byPosition.type).toBe('const doc: Doc');
  });

  test('carries JSDoc and points an imported name at what it imports', async () => {
    const file = join(sandbox, 'src', 'documented.ts');
    await Bun.write(
      file,
      `import { setCount } from './model';\n\n/**\n * Reset the counter.\n * @deprecated use bump\n */\nexport function reset() {\n  setCount(0);\n}\n`,
    );
    try {
      const doc = await at({ file: 'src/documented.ts', symbol: 'reset' });
      expect(doc.documentation).toBe('Reset the counter.');
      expect(doc.tags).toEqual(['deprecated: use bump']);

      const imported = await at({ file: 'src/documented.ts', line: 1, symbol: 'setCount' });
      expect(imported.kind).toBe('alias');
      expect(imported.type).toContain('import setCount');
      expect(imported.definition).toMatchObject({ file: 'src/model.ts' });
    } finally {
      await rm(file);
    }
  });

  test('refuses by kind, as findReferences does', async () => {
    const kindOf = async (query: TypeAtQuery) => {
      const result = await typeAt(sandbox, query);
      return result.success ? 'success' : result.kind;
    };
    expect(await kindOf({ file: 'src/main.ts' })).toBe('invalid');
    expect(await kindOf({ file: 'src/missing.ts', symbol: 'x' })).toBe('not-found');
    expect(await kindOf({ file: 'src/main.ts', line: 999, column: 1 })).toBe('invalid');
  });
});
