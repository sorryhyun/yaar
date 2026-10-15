import { describe, expect, test } from 'bun:test';
import { loadTypeScript } from '../load-typescript.js';
import { rewriteHtmlClosingTags } from '../guards/html-closing-tags.js';

const ts = await loadTypeScript();
const rewrite = (src: string) => rewriteHtmlClosingTags(ts, 'x.ts', src);

describe('rewriteHtmlClosingTags', () => {
  test('leaves a plain template string alone', () => {
    const src = 'const tag = "g";\nexport const svg = `<${tag} id="a"></${tag}>`;';
    expect(rewrite(src)).toBe(src);
  });

  test('rewrites closing tags inside html templates', () => {
    const src = 'const v = html`<${Card}>hi</${Card}>`;';
    expect(rewrite(src)).toBe('const v = html`<${Card}>hi</>`;');
  });

  test('rewrites html templates but not plain strings in the same file', () => {
    const src = [
      'const s = `<${t}></${t}>`;',
      'const v = html`<${A}></${A}>`;',
      'const w = `<${t}></${t}>`;',
    ].join('\n');
    expect(rewrite(src)).toBe(
      [
        'const s = `<${t}></${t}>`;',
        'const v = html`<${A}></>`;',
        'const w = `<${t}></${t}>`;',
      ].join('\n'),
    );
  });

  test('rewrites an html template nested in a plain template substitution', () => {
    const src = 'const s = `<${t}>${html`<${A}></${A}>`}</${t}>`;';
    expect(rewrite(src)).toBe('const s = `<${t}>${html`<${A}></>`}</${t}>`;');
  });

  test('rewrites an html template nested in an html template', () => {
    const src = 'const v = html`<${A}>${html`<${B}></${B}>`}</${A}>`;';
    expect(rewrite(src)).toBe('const v = html`<${A}>${html`<${B}></>`}</>`;');
  });
});
