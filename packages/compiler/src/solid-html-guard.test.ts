import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { classifyTemplate, scanSource, type SolidHtmlDefectKind } from './solid-html-guard.js';

/**
 * Every expectation below was verified against the real solid-js browser build,
 * bundled through this package's own plugin chain and rendered in a DOM. Do not
 * "fix" a case here without re-running that check — the lead/trail asymmetry is
 * genuine, not a bug in the classifier.
 */
describe('classifyTemplate', () => {
  const safe: Array<[string, string[]]> = [
    ['`${x} bye` — trailing text survives, it follows the marker tag', ['', ' bye']],
    ['`${x}${x}` — two markers, so neither is the lone top-level node', ['', '', '']],
    ['`<!--c-->${x}` — comment node precedes the marker', ['<!--c-->', '']],
    ['`<br>${x}` — element precedes the marker', ['<br>', '']],
    ['`${x}<br>` — element follows the marker', ['', '<br>']],
    ['`<div>${x}</div>` — marker is nested, not top-level', ['<div>', '</div>']],
    ['`<${Comp}>` — component tag normalizes to <###>', ['<', '>']],
    ['multi-line markup', ['\n  <div>\n    ', '\n  </div>\n']],
  ];
  for (const [name, statics] of safe) {
    test(`safe: ${name}`, () => expect(classifyTemplate(statics)).toBeNull());
  }

  const broken: Array<[string, string[], SolidHtmlDefectKind]> = [
    ['`${x}` alone', ['', ''], 'lone-expression'],
    ['`${x} ` trailing whitespace only', ['', ' '], 'lone-expression'],
    ['` ${x}` leading whitespace only', [' ', ''], 'lone-expression'],
    ['newline-wrapped `\\n  ${x}\\n`', ['\n  ', '\n'], 'lone-expression'],
    ['`hi ${x}` leading text, nothing after', ['hi ', ''], 'leading-text'],
    // Renders without throwing, but "hi " never reaches the DOM.
    ['`hi ${x} bye` leading text, later node exists', ['hi ', ' bye'], 'leading-text'],
    ['`lead <b>x</b>` silent text loss', ['lead <b>x</b>'], 'leading-text'],
    ['`hi` no tags at all', ['hi'], 'no-tag'],
    ['empty template', [''], 'no-tag'],
  ];
  for (const [name, statics, kind] of broken) {
    test(`broken: ${name}`, () => expect(classifyTemplate(statics)?.kind).toBe(kind));
  }
});

describe('scanSource', () => {
  const scan = (src: string) => scanSource(ts, src, 'main.ts');

  test('finds a lone-expression template', () => {
    const f = scan('const a = html`${x}`;');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('lone-expression');
    expect(f[0].line).toBe(1);
  });

  test('finds a template nested inside another template expression', () => {
    const f = scan('const a = html`<div>${cond() ? html`${x}` : null}</div>`;');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('lone-expression');
  });

  test('is not fooled by braces or backticks inside an expression', () => {
    const f = scan('const a = html`<div>${fn({ k: `v` })}</div>`;');
    expect(f).toEqual([]);
  });

  test('ignores tagged templates that are not `html`', () => {
    expect(scan('const a = css`${x}`;')).toEqual([]);
    expect(scan('const a = `${x}`;')).toEqual([]);
  });

  test('reports every offender in a file', () => {
    const f = scan('const a = html`${x}`;\nconst b = html`hi ${y}`;\nconst c = html`<p>${z}</p>`;');
    expect(f.map((x) => x.kind)).toEqual(['lone-expression', 'leading-text']);
    expect(f.map((x) => x.line)).toEqual([1, 2]);
  });
});
