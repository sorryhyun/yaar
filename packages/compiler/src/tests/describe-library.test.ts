import { describe, expect, test } from 'bun:test';
import { getBundledLibraryDetail } from '../bundled/describe-library.js';
import { upstreamSpecifiers } from '../bundled/describe-upstream.js';
import { BUNDLED_LIBRARIES } from '../bundled/registry.js';

const SECTIONED = ['yaar', 'yaar-web'] as const;

/** Value and type exports declared inside the library's module block(s). */
async function declaredExports(name: string): Promise<{ values: string[]; types: string[] }> {
  const full = (await getBundledLibraryDetail(name, { full: true }))!;
  const block = full.slice(full.indexOf(`declare module '@bundled/${name}'`));
  const values = new Set<string>();
  const types = new Set<string>();
  for (const [, kind, id] of block.matchAll(
    /^ {2}export (?:declare )?(function|const|let|class|type|interface|enum)\s+(\w+)/gm,
  )) {
    (kind === 'type' || kind === 'interface' || kind === 'enum' ? types : values).add(id);
  }
  return { values: [...values], types: [...types] };
}

describe('a sectioned library answers with its index', () => {
  for (const name of SECTIONED) {
    test(`${name}: the index names every export, at a fraction of the full size`, async () => {
      const index = (await getBundledLibraryDetail(name))!;
      const full = (await getBundledLibraryDetail(name, { full: true }))!;
      const { values, types } = await declaredExports(name);
      // A member the parser dropped would vanish from the only list an agent reads first.
      for (const id of [...values, ...types]) expect(index).toContain(`\`${id}\``);
      expect(index.length).toBeLessThan(full.length / 2);
    });
  }

  test('yaar stays small enough to be the default answer', async () => {
    expect((await getBundledLibraryDetail('yaar'))!.length).toBeLessThan(10_000);
  });

  // The first `three` lookup builds a TypeScript program over its upstream types: under a
  // loaded CI runner that cold start alone has run past bun's 5s default.
  test('an unsectioned library answers in full, as before', async () => {
    for (const name of ['three', 'solid-js', 'zod']) {
      expect(await getBundledLibraryDetail(name)).toBe(
        await getBundledLibraryDetail(name, { full: true }),
      );
    }
  }, 30_000);
});

describe('a symbol slice', () => {
  for (const name of SECTIONED) {
    test(`${name}: every export resolves, and never names a module type it does not show`, async () => {
      const { values, types } = await declaredExports(name);
      const localTypes = new Set(types);
      for (const id of [...values, ...types]) {
        const slice = (await getBundledLibraryDetail(name, { symbol: id }))!;
        expect(slice.startsWith('No export')).toBe(false);
        expect(slice).toMatch(new RegExp(`\\b${id}\\b`));
        for (const [, ref] of slice.matchAll(/\b([A-Z]\w*)\b/g)) {
          if (!localTypes.has(ref)) continue;
          expect(slice).toMatch(new RegExp(`(type|interface|enum|class) ${ref}\\b`));
        }
      }
    });
  }

  test('pulls the top-level Yaar* chain a signature reaches', async () => {
    const slice = (await getBundledLibraryDetail('yaar', { symbol: 'defineApp' }))!;
    expect(slice).toMatch(/interface YaarAppDefinition\b/);
    expect(slice.length).toBeLessThan(
      (await getBundledLibraryDetail('yaar', { full: true }))!.length / 4,
    );
  });

  test('an unknown symbol names itself and hands back the index', async () => {
    const slice = (await getBundledLibraryDetail('yaar', { symbol: 'createNope' }))!;
    expect(slice.startsWith('No export `createNope` in @bundled/yaar.')).toBe(true);
    expect(slice).toContain('`createSharedSignal`');
  });
});

describe('a section slice', () => {
  test('matches a title case-insensitively and in part', async () => {
    const slice = (await getBundledLibraryDetail('yaar', { section: 'storage' }))!;
    expect(slice).toContain('export const appStorage');
    expect(slice).not.toContain('export function defineApp');
  });

  test('carries the section prose', async () => {
    const slice = (await getBundledLibraryDetail('yaar-web', { section: 'tab lifecycle' }))!;
    expect(slice).toContain('shared Chrome profile');
  });

  test('an unknown section hands back the index', async () => {
    const slice = (await getBundledLibraryDetail('yaar', { section: 'nonsense' }))!;
    expect(slice.startsWith('No section matching "nonsense"')).toBe(true);
  });
});

describe('a block that forwards an npm package', () => {
  test('diff lists the package exports instead of nothing', async () => {
    const detail = (await getBundledLibraryDetail('diff'))!;
    expect(detail).toContain('## Re-exported from `diff`');
    expect(detail).toMatch(/- `diffLines` \(function\) — diffs two blocks of text/);
    expect(detail).toContain('`ChangeObject`');
  });

  test('a symbol resolves to the upstream declaration with the types it names', async () => {
    const slice = (await getBundledLibraryDetail('diff', { symbol: 'diffLines' }))!;
    expect(slice.startsWith("// @bundled/diff — re-exported from 'diff'")).toBe(true);
    expect(slice).toContain('export declare function diffLines(');
    expect(slice).toMatch(/interface ChangeObject\b/);
  });

  test('an unknown symbol counts the upstream exports in its index', async () => {
    const slice = (await getBundledLibraryDetail('diff', { symbol: 'diffNope' }))!;
    expect(slice.startsWith('No export `diffNope` in @bundled/diff.')).toBe(true);
    expect(slice).not.toContain('0 exports');
    expect(slice).toContain('`diffLines`');
  });

  test('a local declaration wins over an upstream one of the same name', async () => {
    const slice = (await getBundledLibraryDetail('marked', { symbol: 'renderMarkdown' }))!;
    expect(slice).not.toContain('re-exported from');
  });

  test('`export =` lists the members reached through the default import', async () => {
    const detail = (await getBundledLibraryDetail('mammoth'))!;
    expect(detail).toContain('members of the default import of `@bundled/mammoth`');
    expect(detail).toContain('`convertToHtml`');
  });

  for (const name of Object.keys(BUNDLED_LIBRARIES)) {
    test(`${name}: every forwarded package lists its exports`, async () => {
      const detail = await getBundledLibraryDetail(name);
      if (!detail) return;
      for (const spec of upstreamSpecifiers(detail)) {
        expect(detail).toContain(`## Re-exported from \`${spec}\``);
      }
      expect(detail).not.toMatch(/\(0 exports\)/);
    });
  }
});
