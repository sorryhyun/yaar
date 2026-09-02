/**
 * `@bundled/marked` — `renderMarkdown`, the parse → sanitize → rewrite-links render
 * six apps used to hand-roll around `marked.parse`.
 *
 * Two halves. The compile half mirrors `three-addons.test.ts`: the shim is
 * registered, an app importing it builds and typechecks, and the bundle carries
 * the link rewrite. The behavior half imports the shim directly and covers what
 * needs no DOM: the never-throws contract, the per-call `Marked` instance (an
 * extension one render registers must not leak into the next, nor into the
 * global `marked`), and the option defaults.
 *
 * What is deliberately NOT asserted here: what `sanitizeHtml` strips, and that an
 * `<a>` gained `target=_blank`. Both need a real DOM — DOMPurify has no `sanitize`
 * at all without a window and is unreliable under happy-dom — so they are verified
 * in a browser, not in this process. DOMPurify is therefore stubbed to the identity
 * below, which is what lets the render logic around it be observed at all.
 */
import { beforeAll, afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { typecheckSandbox } from '../typecheck.js';
import { BUNDLED_LIBRARIES, BUNDLED_SHIMS } from '../bundled/registry.js';

setDefaultTimeout(120_000);

// See the header: no window means no `DOMPurify.sanitize`, and the sanitizer's own
// behavior is not what this file measures. `--isolate` (the units partition) keeps
// the stub from reaching any other file.
mock.module('dompurify', () => ({
  default: { sanitize: (html: string) => html, isSupported: false },
}));

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

const APP_SOURCE = `
import { marked, renderMarkdown } from '@bundled/marked';

export const html = renderMarkdown('# hi', { breaks: true, externalLinks: false, use: [] });
export const raw = marked.parse('plain');
`;

async function writeApp(): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-marked-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), APP_SOURCE);
  await Bun.write(join(sandbox, 'app.json'), '{"appId":"marked-probe","name":"Marked Probe"}');
  return sandbox;
}

describe('@bundled/marked', () => {
  test('is registered through its shim, next to the library it wraps', () => {
    expect(BUNDLED_LIBRARIES.marked).toBe('marked');
    expect(BUNDLED_SHIMS.marked).toContain('marked');
  });

  test('an app compiles against it and the bundle carries the link rewrite', async () => {
    const app = await writeApp();
    const result = await compileTypeScript(app, { title: 'Marked Probe', minify: false });
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const html = await Bun.file(result.outputPath!).text();
    expect(html).toContain('renderMarkdown');
    expect(html).toContain('noopener noreferrer');
    // The upstream API is still re-exported through the shim: the fixture's
    // `marked.parse` call keeps marked's lexer hook in the bundle.
    expect(html).toContain('provideLexer');
  });

  test('typechecks — the .d.ts block declares renderMarkdown and its options', async () => {
    const app = await writeApp();
    const checked = await typecheckSandbox(app, { bundles: [] });
    expect(checked.diagnostics).toEqual([]);
    expect(checked.success).toBe(true);
  });
});

describe('renderMarkdown', () => {
  test('renders GFM and leaves single newlines alone by default', async () => {
    const { renderMarkdown } = await import('../shims/marked.js');
    const out = renderMarkdown('**bold**\nnext');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).not.toContain('<br');
  });

  test('breaks: true turns a newline into <br>', async () => {
    const { renderMarkdown } = await import('../shims/marked.js');
    expect(renderMarkdown('one\ntwo', { breaks: true })).toContain('<br>');
  });

  test('a renderer that throws yields the source as escaped paragraphs, never an empty string', async () => {
    const { renderMarkdown } = await import('../shims/marked.js');
    const boom = {
      renderer: {
        heading(): string {
          throw new Error('boom');
        },
      },
    };
    const out = renderMarkdown('# <title>\n\nsecond & last', { use: [boom] });
    expect(out).not.toBe('');
    expect(out).toContain('&lt;title&gt;');
    expect(out).toContain('second &amp; last');
    expect(out).not.toContain('<title>');
    expect(out.match(/<p>/g)?.length).toBe(2);
  });

  test('empty and non-string input return an empty string rather than throwing', async () => {
    const { renderMarkdown } = await import('../shims/marked.js');
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
    expect(renderMarkdown(null as unknown as string)).toBe('');
    expect(renderMarkdown(undefined as unknown as string)).toBe('');
  });

  test('a `use` extension applies to that render only — not the next, not the global marked', async () => {
    const { marked, renderMarkdown } = await import('../shims/marked.js');
    const fence = {
      renderer: {
        code({ text }: { text: string }): string {
          return `<div class="fence">${text}</div>`;
        },
      },
    };
    expect(renderMarkdown('```\nx\n```', { use: [fence] })).toContain('class="fence"');
    expect(renderMarkdown('```\nx\n```')).toContain('<pre><code>');
    expect(marked.parse('```\nx\n```')).toContain('<pre><code>');
  });
});
