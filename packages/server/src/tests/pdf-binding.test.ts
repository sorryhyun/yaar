/**
 * `@yaar/lib/pdf` takes its poppler directory as a parameter, and `features/pdf.ts` is the
 * one place that supplies it. A call site that imports the library directly compiles and
 * works on every developer machine — poppler is on PATH — and then, in the bundled exe,
 * quietly falls back to a PATH lookup for binaries that ship beside the binary instead.
 * That failure has no test that can feel it (the exe is not what the suite runs), so the
 * rule is checked at the source level: exactly one importer.
 */
import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'path';
import { getPopplerBinDir } from '../config.js';

const SRC = join(import.meta.dir, '..');
const ALLOWED = 'features/pdf.ts';

describe('pdf binding', () => {
  it('only features/pdf.ts imports @yaar/lib/pdf', async () => {
    const importers: string[] = [];
    for await (const rel of new Glob('**/*.ts').scan({ cwd: SRC })) {
      if (rel.startsWith('tests/') || rel.endsWith('.test.ts')) continue;
      const text = await Bun.file(join(SRC, rel)).text();
      if (/from\s+['"]@yaar\/lib\/pdf['"]/.test(text)) importers.push(rel);
    }
    expect(importers).toEqual([ALLOWED]);
  });

  it('resolves no bin dir outside the bundled exe', () => {
    // The suite never runs as the exe, so the source-checkout branch is the one on record.
    expect(getPopplerBinDir()).toBeUndefined();
  });
});
