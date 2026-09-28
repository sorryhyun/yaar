import { describe, expect, test } from 'bun:test';
import { getBundledLibraryDetail } from '../bundled/describe-library.js';

const SECTIONED = ['yaar', 'yaar-web'] as const;

/** Value and type exports declared inside the library's module block(s). */
function declaredExports(name: string): { values: string[]; types: string[] } {
  const full = getBundledLibraryDetail(name, { full: true })!;
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
    test(`${name}: the index names every export, at a fraction of the full size`, () => {
      const index = getBundledLibraryDetail(name)!;
      const full = getBundledLibraryDetail(name, { full: true })!;
      const { values, types } = declaredExports(name);
      // A member the parser dropped would vanish from the only list an agent reads first.
      for (const id of [...values, ...types]) expect(index).toContain(`\`${id}\``);
      expect(index.length).toBeLessThan(full.length / 2);
    });
  }

  test('yaar stays small enough to be the default answer', () => {
    expect(getBundledLibraryDetail('yaar')!.length).toBeLessThan(10_000);
  });

  test('an unsectioned library answers in full, as before', () => {
    for (const name of ['three', 'solid-js', 'zod']) {
      expect(getBundledLibraryDetail(name)).toBe(getBundledLibraryDetail(name, { full: true }));
    }
  });
});

describe('a symbol slice', () => {
  for (const name of SECTIONED) {
    test(`${name}: every export resolves, and never names a module type it does not show`, () => {
      const { values, types } = declaredExports(name);
      const localTypes = new Set(types);
      for (const id of [...values, ...types]) {
        const slice = getBundledLibraryDetail(name, { symbol: id })!;
        expect(slice.startsWith('No export')).toBe(false);
        expect(slice).toMatch(new RegExp(`\\b${id}\\b`));
        for (const [, ref] of slice.matchAll(/\b([A-Z]\w*)\b/g)) {
          if (!localTypes.has(ref)) continue;
          expect(slice).toMatch(new RegExp(`(type|interface|enum|class) ${ref}\\b`));
        }
      }
    });
  }

  test('pulls the top-level Yaar* chain a signature reaches', () => {
    const slice = getBundledLibraryDetail('yaar', { symbol: 'defineApp' })!;
    expect(slice).toMatch(/interface YaarAppDefinition\b/);
    expect(slice.length).toBeLessThan(getBundledLibraryDetail('yaar', { full: true })!.length / 4);
  });

  test('an unknown symbol names itself and hands back the index', () => {
    const slice = getBundledLibraryDetail('yaar', { symbol: 'createNope' })!;
    expect(slice.startsWith('No export `createNope` in @bundled/yaar.')).toBe(true);
    expect(slice).toContain('`createSharedSignal`');
  });
});

describe('a section slice', () => {
  test('matches a title case-insensitively and in part', () => {
    const slice = getBundledLibraryDetail('yaar', { section: 'storage' })!;
    expect(slice).toContain('export const appStorage');
    expect(slice).not.toContain('export function defineApp');
  });

  test('carries the section prose', () => {
    const slice = getBundledLibraryDetail('yaar-web', { section: 'tab lifecycle' })!;
    expect(slice).toContain('shared Chrome profile');
  });

  test('an unknown section hands back the index', () => {
    const slice = getBundledLibraryDetail('yaar', { section: 'nonsense' })!;
    expect(slice.startsWith('No section matching "nonsense"')).toBe(true);
  });
});
