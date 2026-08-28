/**
 * `bundled-types/index.d.ts` restates the wire contracts in `@yaar/shared` under
 * the names apps import. It cannot import them — the file is sliced verbatim
 * into what `describeBundledLibrary` shows an agent, and an alias with no body
 * would show a name and nothing else. So the two are kept identical by proof
 * instead: an app typechecked against the real declarations asserts, type by
 * type, that the app-facing shape and the server-facing shape are the same.
 *
 * A field added to one side fails here with the name of the pair that split.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { typecheckSandbox } from '../typecheck.js';
import { toForwardSlash } from '../bundled/registry.js';

setDefaultTimeout(30_000);

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..');
const SHARED_SRC = toForwardSlash(join(PROJECT_ROOT, 'packages/shared/src'));

beforeAll(() => {
  initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: false });
});

/** Mutual assignability, checked as a pair so the failing side is named. */
const PRELUDE = `
type Same<Wire, App> = [Wire] extends [App] ? ([App] extends [Wire] ? true : never) : never;
`;

/** Shared leaf modules by type: imported directly so nothing else in `shared/src` rides along. */
const SHARED_MODULE: Record<string, string> = {
  ServedFontFace: 'fonts',
  FontCatalog: 'fonts',
  FontMetrics: 'fonts',
  FontSubsetFace: 'fonts',
  FontSubsetResult: 'fonts',
  BrowserActionResponse: 'browser',
  BrowserImageResponse: 'browser',
  BrowserTabSummary: 'browser',
  BrowserScrollToBottomResult: 'browser',
  BrowserHtmlWithMeta: 'browser',
  BrowserAnnotatedElement: 'browser',
  BrowserCookie: 'browser',
};

const PAIRS: Array<[shared: string, app: string, module: string]> = [
  // yaar://system/fonts  ↔  @bundled/yaar fonts.*
  ['ServedFontFace', 'YaarServedFace', '@bundled/yaar'],
  ['FontCatalog', 'YaarFontCatalog', '@bundled/yaar'],
  ['FontMetrics', 'YaarFontMetrics', '@bundled/yaar'],
  ['FontSubsetFace', 'YaarInlinedFace', '@bundled/yaar'],
  ['FontSubsetResult', 'YaarInlinedFonts', '@bundled/yaar'],
  // POST /api/browser  ↔  @bundled/yaar-web
  ['BrowserActionResponse', 'WebResult', '@bundled/yaar-web'],
  ['BrowserImageResponse', 'WebImageResult', '@bundled/yaar-web'],
  ['BrowserTabSummary', 'WebTab', '@bundled/yaar-web'],
  ['BrowserScrollToBottomResult', 'WebScrollToBottomResult', '@bundled/yaar-web'],
  ['BrowserHtmlWithMeta', 'WebHtmlWithMeta', '@bundled/yaar-web'],
  ['BrowserAnnotatedElement', 'WebAnnotatedElement', '@bundled/yaar-web'],
  ['BrowserCookie', 'WebCookie', '@bundled/yaar-web'],
];

function paritySource(pairs: typeof PAIRS): string {
  const modules = [...new Set(pairs.map(([, , m]) => m))];
  const appImports = modules
    .map(
      (m) =>
        `import type { ${pairs
          .filter(([, , mod]) => mod === m)
          .map(([, app]) => app)
          .join(', ')} } from '${m}';`,
    )
    .join('\n');
  const sharedModules = [...new Set(pairs.map(([s]) => SHARED_MODULE[s]))];
  const sharedImports = sharedModules
    .map(
      (m) =>
        `import type { ${pairs
          .filter(([s]) => SHARED_MODULE[s] === m)
          .map(([s]) => s)
          .join(', ')} } from '${SHARED_SRC}/${m}.js';`,
    )
    .join('\n');
  // One check per line, after a known-length header, so a tsc position maps to a pair.
  const header = `${appImports}\n${sharedImports}\n${PRELUDE}`;
  const checks = pairs
    .map(([shared, app]) => `export const ${shared}_is_${app}: Same<${shared}, ${app}> = true;`)
    .join('\n');
  return `${header}\n${checks}\n`;
}

/** tsc names a position; turn `main.ts(N,C)` back into the pair on that line. */
function nameDrift(source: string, diagnostics: string[]): string[] {
  const lines = source.split('\n');
  return diagnostics.map((d) => {
    const m = /main\.ts\((\d+),\d+\)/.exec(d);
    const line = m ? lines[Number(m[1]) - 1] : undefined;
    const pair = line && /export const (\w+):/.exec(line)?.[1];
    return pair ? `${pair}: ${d}` : d;
  });
}

async function check(source: string) {
  const sandbox = await mkdtemp(join(tmpdir(), 'yaar-parity-'));
  try {
    await mkdir(join(sandbox, 'src'));
    await Bun.write(join(sandbox, 'src', 'main.ts'), source);
    return await typecheckSandbox(sandbox, { bundles: ['yaar-web'] });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe('bundled-types parity with @yaar/shared wire contracts', () => {
  test('every app-facing restatement is identical to its shared declaration', async () => {
    const source = paritySource(PAIRS);
    const result = await check(source);
    expect(nameDrift(source, result.diagnostics)).toEqual([]);
    expect(result.success).toBeTrue();
  });

  test('the proof is live: a drifted pair fails', async () => {
    const drifted = paritySource([['FontMetrics', 'YaarServedFace', '@bundled/yaar']]);
    const result = await check(drifted);
    expect(result.success).toBeFalse();
    expect(nameDrift(drifted, result.diagnostics).join('\n')).toContain(
      'FontMetrics_is_YaarServedFace',
    );
  });
});
