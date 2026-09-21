import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every CSS module under `styles/` is imported by something.
 *
 * `styles/` mirrors `components/` rather than sitting beside it, so deleting a component
 * leaves its stylesheet on disk in a tree the deleter never looked at. That has happened
 * twice: `SessionsModal.module.css` survived a cleanup that removed every other trace of
 * the feature, and deleting three dead overlays orphaned three more. A grep is what the
 * convention costs, so the grep is here.
 */
const SRC = join(import.meta.dir, '../..');
const STYLES_DIR = join(SRC, 'styles');

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

describe('styles/', () => {
  test('holds no CSS module that nothing imports', () => {
    const sources = walk(SRC, (n) => /\.(tsx?|css)$/.test(n))
      .filter((f) => !f.includes('/tests/'))
      .map((f) => readFileSync(f, 'utf-8'))
      .join('\n');

    const orphans = walk(STYLES_DIR, (n) => n.endsWith('.module.css'))
      .map((f) => relative(STYLES_DIR, f))
      .filter((rel) => !sources.includes(`styles/${rel}`) && !sources.includes(`./${rel}`));

    expect(orphans).toEqual([]);
  });
});
