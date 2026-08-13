/**
 * Every prebundled `@bundled/*` library survives being consumed by an app.
 *
 * The exe embeds one prebundled ESM file per bundled library (see
 * `prebundle.ts` / `scripts/build/prebundle-libs.js`). A class of library — pure
 * re-export barrels like `uuid`, `zod/mini`, `lodash-es` — bundles into an
 * artifact whose `export { ... }` list references identifiers Bun dropped or
 * renamed. The prebundle itself *succeeds*, so the breakage is invisible until
 * an app imports the library and its compile dies with
 * `"<id>" is not declared in this file`. Real incidents: installing an app that
 * used `@bundled/zod` or `@bundled/lodash` failed exactly this way.
 *
 * This test closes the gap by doing what the exe does — prebundle each library,
 * then compile a consumer against the artifact — and asserting the consumer
 * builds. A dropped binding surfaces here as a failed consumer compile, at test
 * time, for the specific library, instead of at install time in the field.
 *
 * The consumer imports the artifact the way an app is *allowed* to: a namespace
 * import always, plus a default import for every library whose `.d.ts` block
 * declares one. The default half was added after `@bundled/mammoth` — CommonJS,
 * typed `export = mammoth` — shipped an artifact with named exports and no
 * default, so `import mammoth from '@bundled/mammoth'` typechecked, compiled in
 * dev, and failed at install time against the release with `No matching export
 * in "bundled-lib:mammoth" for import "default"`. A namespace import never asks
 * for `default`, so this test passed the whole time.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUNDLED_LIBRARIES,
  BUNDLED_SHIMS,
  prebundleLibrary,
  resolvePrebundleEntrypoint,
  toForwardSlash,
} from '../index.js';
import { BUNDLED_TYPES_DTS } from '../paths.js';

const DTS = readFileSync(BUNDLED_TYPES_DTS, 'utf-8');

/**
 * Does `declare module '@bundled/<name>'` promise a default export?
 *
 * Derived from the `.d.ts` rather than listed here, so a library that gains or
 * loses a default is probed accordingly without anyone remembering to say so.
 * The block is matched by exact module name (never a `/…` subpath): `solid-js`
 * has no default of its own, `solid-js/html` does.
 */
function declaresDefaultExport(name: string): boolean {
  const start = DTS.indexOf(`declare module '@bundled/${name}' {`);
  if (start === -1) return false;
  const next = DTS.indexOf(`\ndeclare module '`, start + 1);
  const block = DTS.slice(start, next === -1 ? undefined : next);
  return /^\s*export\s+(default\b|=|\{[^}]*\bdefault\b)/m.test(block);
}

// Each case pays for a real prebundle (some libraries are megabytes) plus a
// consumer Bun.build(). Big libs (mermaid, three, mammoth) dominate the cost.
setDefaultTimeout(120_000);

// solid-js sub-package artifacts carry bare `import 'solid-js'` (its sisters are
// marked external at prebundle time and redirected at runtime). Mark them
// external in the consumer too so bare imports resolve — this test is about a
// library's own exports, not about resolving solid's shared runtime.
const SOLID_EXTERNAL = ['solid-js', 'solid-js/web', 'solid-js/html', 'solid-js/store'];

describe('prebundle completeness', () => {
  for (const name of Object.keys(BUNDLED_LIBRARIES)) {
    test(`@bundled/${name}: prebundled artifact's exports all resolve`, async () => {
      const code = await prebundleLibrary(name);
      expect(code.length).toBeGreaterThan(0);

      const dir = await mkdtemp(join(tmpdir(), 'yaar-prebundle-'));
      try {
        const artifact = join(dir, 'lib.js');
        await Bun.write(artifact, code);

        // A namespace import forces Bun to process the artifact's entire export
        // list; referencing `lib` keeps it from being tree-shaken away. If any
        // export references a dropped/renamed identifier, this build fails with
        // `"<id>" is not declared in this file` — exactly the field failure.
        // A library whose type surface promises a default is imported both ways,
        // because only the default import fails when the default is missing.
        const spec = JSON.stringify(toForwardSlash(artifact));
        const wantsDefault = declaresDefaultExport(name);
        const consumer = join(dir, 'consumer.ts');
        await Bun.write(
          consumer,
          `import * as lib from ${spec};\n` +
            (wantsDefault ? `import def from ${spec};\n` : '') +
            `(globalThis as Record<string, unknown>).__probe = ` +
            `${wantsDefault ? '[lib, def]' : 'lib'};\n`,
        );

        const result = await Bun.build({
          entrypoints: [consumer],
          minify: true,
          format: 'esm',
          target: 'browser',
          external: SOLID_EXTERNAL,
        });

        const errors = result.success
          ? []
          : result.logs.filter((l) => l.level === 'error').map((l) => l.message || String(l));
        expect(errors).toEqual([]);
        expect(result.success).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  /**
   * dompurify is the only bundled library that is also a dependency of another
   * build in this same process: `@bundled/yaar`'s `sanitizeHtml` imports it, so
   * every app compile in `define-app.test.ts` / `fold-schemas.test.ts` loads the
   * same `dist/purify.es.mjs` the prebundle above would otherwise have used as an
   * *entrypoint*. Bun's bundler does not survive one file playing both roles: the
   * later compiles die with `EISDIR reading file: ".../purify.es.mjs"` on a file
   * that is not a directory. `shims/dompurify.ts` demotes it to an inner module.
   *
   * Guarded here rather than left to the suites it breaks, because the damage is
   * ordering- and timing-dependent: dropping the shim reproduces most of the
   * time, not every time, and lands as 15 unexplained failures in files that pass
   * when run alone.
   */
  test('dompurify prebundles through its shim, never as the npm file itself', () => {
    expect(resolvePrebundleEntrypoint('dompurify')).toBe(BUNDLED_SHIMS.dompurify);
  });

  /**
   * The same defect from the other side, which the shim above cannot reach.
   *
   * A test file that *imports* dompurify — directly, or transitively through the
   * `shims/yaar/index.js` barrel, whose `sanitizeHtml` pulls it in — loads
   * `dist/purify.es.mjs` through Bun's **runtime loader**. Every later
   * `Bun.build()` in that process then fails to read the same file with `EISDIR`.
   * Demoting it to an inner module fixes the bundler-vs-bundler collision; it does
   * nothing for loader-vs-bundler.
   *
   * The failures land in whichever file compiles an app afterwards, never in the
   * one that did the import: `bun test yaar.test.ts define-app.test.ts` failed
   * four of define-app's compiles while either file alone passed, and which four
   * depends on run order. So this is asserted over the source text — a test that
   * reproduced it would have to poison the process it runs in.
   *
   * A test that needs the sanitizer itself is not forbidden by this, but it does
   * need its own process; see `scripts/test/partitions.ts`.
   */
  test('no compiler test loads dompurify at runtime, directly or via the yaar barrel', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(import.meta.dir)) {
      if (!file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(import.meta.dir, file), 'utf-8');
      // Import forms only — a mention inside a comment (this block is one) is not a load.
      const specs = [...source.matchAll(/(?:\bfrom|\bimport\s*\()\s*'([^']+)'/g)].map((m) => m[1]);
      for (const spec of specs) {
        if (spec === 'dompurify' || /shims\/yaar\/index(\.js)?$/.test(spec)) {
          offenders.push(`${file} imports '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
