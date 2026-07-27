/**
 * Every prebundled `@bundled/*` library survives being consumed by an app.
 *
 * The exe embeds one prebundled ESM file per bundled library (see
 * `prebundle.ts` / `scripts/prebundle-libs.js`). A class of library — pure
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
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
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

// Each case pays for a real prebundle (some libraries are megabytes) plus a
// consumer Bun.build(). Big libs (p5, three, mammoth) dominate the cost.
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
        const consumer = join(dir, 'consumer.ts');
        await Bun.write(
          consumer,
          `import * as lib from ${JSON.stringify(toForwardSlash(artifact))};\n` +
            `(globalThis as Record<string, unknown>).__probe = lib;\n`,
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
});
