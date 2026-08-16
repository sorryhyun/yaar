/**
 * The source guards, run over a directory instead of from inside a build.
 *
 * Both rules are enforced in the bundler's `onLoad` hook, which only fires during
 * `compile` — so a project could accumulate two files breaking the same rule and
 * hear about it once, at the end, in one error. Neither rule needs type
 * information or a bundle, so `typecheckSandbox` runs them too and the same
 * findings arrive at the earlier call.
 *
 * The output is deliberately tsc-shaped (`path(line,col): error CODE: message`):
 * every consumer of a diagnostics list already parses that, so nothing downstream
 * needed a new format to show these.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanProjectGuards } from '../guards/scan-project.js';

let root: string;

async function write(rel: string, text: string) {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, text, 'utf8');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-scan-'));
  // The report's own case: two files, same rule, written before anything checked.
  await write(
    'src/ui/BaitPanel.ts',
    [
      "import html from '@bundled/solid-js/html';",
      'export function BaitPanel(verdict) {',
      '  return html`${() => (verdict() ? verdict().label : null)}`;',
      '}',
    ].join('\n'),
  );
  await write(
    'src/ui/PostItem.ts',
    [
      "import html from '@bundled/solid-js/html';",
      'export function PostItem(folded, foldedRow, fullRow) {',
      '  return html`${() => (folded() ? foldedRow() : fullRow())}`;',
      '}',
    ].join('\n'),
  );
  await write(
    'src/ok.ts',
    [
      "import html from '@bundled/solid-js/html';",
      'export const Ok = (x) => html`<p>${x}</p>`;',
    ].join('\n'),
  );
  await write('src/plain.ts', 'export const n = 1;\n');
  // A closing tag the compiler plugin rewrites before parsing. Scanning the raw
  // text instead would report a template that builds fine.
  await write(
    'src/closing.ts',
    [
      "import html from '@bundled/solid-js/html';",
      'export const Wrap = (Comp, x) => html`<div><${Comp}>${x}</${Comp}></div>`;',
    ].join('\n'),
  );
  await write(
    'src/mount.ts',
    [
      "import { render } from '@bundled/solid-js/web';",
      "render(() => null, document.getElementById('root'));",
    ].join('\n'),
  );
  // Never walked: the guards describe source, and dist/ is output.
  await write('dist/bundle.ts', 'const html = 0; export const bad = html`${1}`;\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanProjectGuards', () => {
  test('reports every broken template in one pass, not one build at a time', async () => {
    const found = await scanProjectGuards(root);
    const html = found.filter((d) => d.includes('YAAR_HTML'));
    expect(html).toHaveLength(2);
    expect(html.join('\n')).toContain('src/ui/BaitPanel.ts(');
    expect(html.join('\n')).toContain('src/ui/PostItem.ts(');
  });

  test('names the fix, not just the defect', async () => {
    const [first] = (await scanProjectGuards(root)).filter((d) => d.includes('YAAR_HTML'));
    expect(first).toContain('the only top-level node is the expression');
    expect(first).toContain('Fix:');
  });

  test('parses as tsc does, so existing diagnostic readers need no new format', async () => {
    for (const line of await scanProjectGuards(root)) {
      expect(line).toMatch(/^[^(]+\(\d+,\d+\): error \w+: .+/);
    }
  });

  test('catches a dead mount target too', async () => {
    const mount = (await scanProjectGuards(root)).filter((d) => d.includes('YAAR_MOUNT'));
    expect(mount).toHaveLength(1);
    expect(mount[0]).toContain('src/mount.ts(');
    expect(mount[0]).toContain('"root"');
  });

  test('leaves clean files, rewritten closing tags, and dist/ alone', async () => {
    const found = (await scanProjectGuards(root)).join('\n');
    expect(found).not.toContain('src/ok.ts');
    expect(found).not.toContain('src/plain.ts');
    expect(found).not.toContain('src/closing.ts');
    expect(found).not.toContain('dist/');
  });

  test('says nothing about a project with no src/', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'yaar-scan-empty-'));
    try {
      expect(await scanProjectGuards(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
