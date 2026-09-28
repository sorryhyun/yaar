import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { formatClassFindings, knownClasses, scanClasses } from '../guards/design-class-guard.js';
import { describeDesignTokens } from '../design-tokens.js';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';

const file = (text: string, path = 'src/main.ts') => ({ path, text });
const names = (text: string, extra: { path: string; text: string }[] = []) =>
  scanClasses([file(text), ...extra]).map((f) => f.className);

describe('the known set', () => {
  test('is every class advertised to agents, parsed from the injected CSS', () => {
    const known = knownClasses();
    expect(known.has('y-btn')).toBe(true);
    expect(known.has('y-flex-col')).toBe(true); // shares a line with .y-flex
    const advertised = [...describeDesignTokens().matchAll(/\.(y-[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(advertised.filter((c) => !known.has(c))).toEqual([]);
  });
});

describe('reports a y- class nothing defines', () => {
  test('in an html template attribute, with a suggestion', () => {
    // The real miss that found this: Tailwind spellings in dc-comics.
    const findings = scanClasses([
      file('html`<div class="detail-empty y-flex-col y-items-center">`'),
    ]);
    expect(findings.map((f) => f.className)).toEqual(['y-items-center']);
    expect(findings[0]).toMatchObject({ line: 1, column: 42, suggestion: 'y-flex-center' });
  });

  test('in JSX, className assignment, object properties and classList calls', () => {
    expect(names('<div className="y-nope-a" />')).toEqual(['y-nope-a']);
    expect(names("el.className = 'y-btn y-nope-b';")).toEqual(['y-nope-b']);
    expect(names("h('div', { class: 'y-nope-c' })")).toEqual(['y-nope-c']);
    expect(names("el.classList.add('y-btn', 'y-nope-d');")).toEqual(['y-nope-d']);
    expect(names("el.classList.toggle('y-nope-e', on);")).toEqual(['y-nope-e']);
  });

  test('inside a ${} expression in a class attribute', () => {
    expect(names("html`<b class=\"y-btn ${on() ? 'y-nope-f' : ''}\">`")).toEqual(['y-nope-f']);
  });

  test('positions each finding on its own line', () => {
    const [f] = scanClasses([file('const a = 1;\nconst b = html`\n  <i class="x y-nope-g">`;')]);
    expect(f).toMatchObject({ line: 3, column: 15 });
  });
});

describe('stays quiet', () => {
  test('on shipped classes', () => {
    expect(names('html`<div class="y-app y-btn y-btn-primary y-scroll">`')).toEqual([]);
  });

  test('on names it cannot read whole', () => {
    expect(names('html`<b class="y-btn-${variant}">`')).toEqual([]);
    expect(names("el.className = 'y-tone-' + tone;")).toEqual([]);
    expect(names('el.classList.add(`y-${kind}`);')).toEqual([]);
  });

  test('on y- words that are not in a class list', () => {
    expect(names("chart.label('y-axis'); const k = 'y-offset';")).toEqual([]);
  });

  test('on a class the app defines in its own CSS', () => {
    const css = file('.y-card-grid { display: grid }\n/* .y-dead */', 'src/styles.css');
    expect(names('html`<div class="y-card-grid">`', [css])).toEqual([]);
    expect(names('html`<div class="y-dead">`', [css])).toEqual(['y-dead']);
  });

  test('on a class defined in a style block inside TS', () => {
    expect(names('const s = `.y-local { color: red }`; html`<p class="y-local">`')).toEqual([]);
  });

  test('on CSS files, which define rather than use', () => {
    expect(scanClasses([file('.y-app .y-whatever { }', 'src/a.css')])).toEqual([]);
  });
});

test('the report is ASCII, like every guard report', () => {
  const lines = formatClassFindings(scanClasses([file('html`<i class="y-nope y-items-center">`')]));
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
});

describe('compileTypeScript', () => {
  // A warning, not an error: the build ships, and the finding rides on the result.
  test('ships the app and carries the finding as a warning', async () => {
    initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
    const sandbox = await mkdtemp(join(tmpdir(), 'yaar-class-guard-'));
    try {
      await mkdir(join(sandbox, 'src'), { recursive: true });
      await Bun.write(
        join(sandbox, 'src', 'main.ts'),
        `document.body.innerHTML = '<div class="y-app y-items-center"></div>';\n`,
      );
      const result = await compileTypeScript(sandbox, { title: 'Class Guard', minify: false });
      expect(result.errors ?? []).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('src/main.ts:1:46: unknown class .y-items-center');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});
