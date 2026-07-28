/**
 * Compile every bundled app to apps/{id}/dist/ for the release archive.
 *
 * The standalone exe embeds the frontend, bundled libs, and ML runtime, but NOT
 * apps — it reads them from dirname(execPath)/apps at runtime. The release pipeline
 * tars apps/ into yaar-apps.tar.gz and the installers extract it next to the binary;
 * this script is what fills apps/*\/dist first.
 *
 * It reuses the server's own autoCompileApps (the pass the dev server runs at
 * startup), so a CI build and a `make dev` build compile identically. Hash-based
 * staleness skips unchanged apps, and each app ships a .build-manifest.json so the
 * installed copy is not stale on the user's machine and never triggers a recompile.
 *
 * Run after `bun run --filter '*' build`: initCompiler is imported from the compiler's
 * built dist so it is the SAME module instance autoCompileApps resolves @yaar/compiler
 * to. Importing the source instead would configure a different instance and
 * compileTypeScript would throw "compiler not configured".
 */

import { initCompiler } from '../../packages/compiler/dist/index.js';
import { PROJECT_ROOT, IS_BUNDLED_EXE } from '../../packages/server/src/config.ts';
import { autoCompileApps } from '../../packages/server/src/features/apps/auto-compile.ts';

initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: IS_BUNDLED_EXE });

const result = await autoCompileApps();

console.log(
  '[build-apps] compiled ' +
    result.compiled.length +
    ', skipped ' +
    result.skipped.length +
    ', failed ' +
    result.failed.length,
);
if (result.compiled.length) console.log('  compiled: ' + result.compiled.join(', '));
for (const f of result.failed) console.error('  FAIL ' + f.appId + ': ' + f.errors.join('; '));

// A failed app compile must fail the release — shipping a half-built apps/ would leave
// broken windows in the installed product.
if (result.failed.length > 0) process.exit(1);
