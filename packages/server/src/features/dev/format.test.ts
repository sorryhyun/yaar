/**
 * Dev-Tools formatter tests.
 *
 * The contract worth pinning is not "prettier works" — it is that this returns the
 * *repo's* style (a project formatted in Dev Tools must not need reformatting once
 * deployed into `apps/`), and that its three refusals stay distinguishable. A caller
 * that cannot tell "no formatter for .md" from "your code does not parse" reports the
 * second as the first.
 *
 * It reads the real `.prettierrc` and the real prettier, and needs nothing pinned for a
 * whole process, so it belongs to the shared `units` partition. See
 * `scripts/test/partitions.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { formatSource, parserFor } from './format.js';

describe('parserFor', () => {
  test('maps the extensions it serves and refuses the rest', () => {
    expect(parserFor('src/main.ts')).toBe('typescript');
    expect(parserFor('src/ui/App.tsx')).toBe('typescript');
    expect(parserFor('src/legacy.mjs')).toBe('babel');
    expect(parserFor('src/styles/base.CSS')).toBe('css');
    expect(parserFor('app.json')).toBe('json');
    expect(parserFor('agent/SKILL.md')).toBeNull();
    expect(parserFor('logo.png')).toBeNull();
    expect(parserFor('Makefile')).toBeNull();
  });
});

describe('formatSource', () => {
  test("applies the repo's own style, not prettier's defaults", async () => {
    const result = await formatSource('const   x=1\nlet y = "a"\n', 'src/main.ts');
    if (!result.ok) throw new Error(`expected a format, got ${result.kind}: ${result.reason}`);
    // singleQuote and semi are the two `.prettierrc` settings that differ visibly from
    // the defaults — if config resolution silently fell back, the quotes stay double.
    expect(result.formatted).toBe("const x = 1;\nlet y = 'a';\n");
    expect(result.changed).toBe(true);
  });

  test('reports already-formatted text as unchanged', async () => {
    const result = await formatSource("const x = 1;\nlet y = 'a';\n", 'src/main.ts');
    if (!result.ok) throw new Error(`expected a format, got ${result.kind}`);
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe("const x = 1;\nlet y = 'a';\n");
  });

  test('formats css and json through their own parsers', async () => {
    const css = await formatSource('body{color:red}', 'src/a.css');
    expect(css.ok && css.formatted).toBe('body {\n  color: red;\n}\n');
    const json = await formatSource('{"a":1}', 'app.json');
    expect(json.ok).toBe(true);
  });

  test('refuses an extension nothing formats, naming what it does format', async () => {
    const result = await formatSource('# hi', 'README.md');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toContain('.ts');
  });

  test('passes a syntax error through with its line, and does not throw', async () => {
    const result = await formatSource('const x =', 'src/broken.ts');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.kind).toBe('parse');
    // The location is the whole value of a parse failure — a bare "could not format"
    // would leave the caller re-reading the file to find out where.
    expect(result.reason).toContain('1:10');
  });
});
