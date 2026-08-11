/**
 * What a caller's grep glob means.
 *
 * `Bun.Glob`'s `*` does not cross a `/`, and the matcher was applied to the path
 * relative to the scope root — so `*.md`, the spelling this verb's own schema
 * used as its example, could only match a file sitting directly in the scope
 * root. Every nested file was dropped with no error, no `truncated` flag, just a
 * well-formed empty result that reads exactly like "the pattern is not here".
 *
 * A slashless glob is a basename pattern (ripgrep / `git grep` semantics); a
 * glob that names a separator is a path pattern and keeps the literal meaning.
 * `scannedFiles` is what separates "the glob matched nothing" from "the pattern
 * matched nothing" at the call site.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { storageWrite, storageDelete, storageGrep } from '../storage/storage-manager.js';

// `temp/` is the documented scratch prefix; STORAGE_DIR is fixed at import time.
const SCRATCH = `temp/__storage-grep-glob-test-${process.pid}`;

const NEEDLE = 'design token';

beforeAll(async () => {
  await storageWrite(`${SCRATCH}/root.md`, `${NEEDLE} at the root\n`);
  await storageWrite(`${SCRATCH}/nested/deep/note.md`, `a nested ${NEEDLE}\n`);
  await storageWrite(`${SCRATCH}/nested/code.ts`, `// ${NEEDLE} in code\n`);
  await storageWrite(`${SCRATCH}/nested/quiet.md`, 'nothing to find here\n');
});

afterAll(async () => {
  await storageDelete(SCRATCH);
});

/** The matched file paths, sorted, for a grep over the scratch tree. */
async function filesFor(glob?: string): Promise<string[]> {
  const result = await storageGrep(SCRATCH, NEEDLE, glob);
  expect(result.success).toBe(true);
  return (result.matches ?? []).map((m) => m.file).sort();
}

describe('grep glob', () => {
  it('matches a bare extension at any depth', async () => {
    // The reported bug: this returned [] while the same search with no glob
    // found the nested file.
    expect(await filesFor('*.md')).toEqual(['nested/deep/note.md', 'root.md']);
  });

  it('still matches files at the scope root', async () => {
    // `**/` matches a zero-directory prefix, so widening costs no root hits.
    expect(await filesFor('root.md')).toEqual(['root.md']);
  });

  it('filters by extension rather than by depth', async () => {
    expect(await filesFor('*.ts')).toEqual(['nested/code.ts']);
    expect(await filesFor()).toEqual(['nested/code.ts', 'nested/deep/note.md', 'root.md']);
  });

  it('leaves a glob that names a path alone', async () => {
    // A `/` means the caller wrote a path, and `*` still does not cross one.
    expect(await filesFor('nested/*.ts')).toEqual(['nested/code.ts']);
    expect(await filesFor('nested/*.md')).toEqual([]);
    expect(await filesFor('nested/**/*.md')).toEqual(['nested/deep/note.md']);
    expect(await filesFor('**/*.md')).toEqual(['nested/deep/note.md', 'root.md']);
  });

  it('reports how many files the pattern was tested against', async () => {
    // Zero matches because the glob excluded everything...
    const excluded = await storageGrep(SCRATCH, NEEDLE, '*.rs');
    expect(excluded.matches).toEqual([]);
    expect(excluded.scannedFiles).toBe(0);

    // ...versus zero matches because the pattern is genuinely absent.
    const absent = await storageGrep(SCRATCH, 'no-such-string-anywhere', '*.md');
    expect(absent.matches).toEqual([]);
    expect(absent.scannedFiles).toBe(3);
  });
});
