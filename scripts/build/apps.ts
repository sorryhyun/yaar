/**
 * Compile bundled apps to apps/{id}/dist/ — for the release archive, and for
 * checking one app you just edited without starting the server.
 *
 *   bun run build:apps                      # every stale app (what the release runs)
 *   bun run build:apps devtools             # just these ids, stale or not
 *   bun run build:apps devtools --typecheck # ...and run tsc over the app's src/
 *
 * Naming ids implies force: `isAppStale` compares a hash of the app's sources, so
 * an edit outside them (a bundled-library bump, agent/prompt.md) is invisible to
 * it, and "skipped" is a confusing answer to "compile this app".
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

import { existsSync } from 'fs';
import { join } from 'path';
import { initCompiler, typecheckSandbox } from '../../packages/compiler/dist/index.js';
import { PROJECT_ROOT, IS_BUNDLED_EXE } from '../../packages/server/src/config.ts';
import { autoCompileApps } from '../../packages/server/src/features/apps/auto-compile.ts';
import { APP_ROOTS } from '../../packages/server/src/features/apps/roots.ts';

const argv = process.argv.slice(2);
const wantTypecheck = argv.includes('--typecheck');
const only = argv.filter((a) => !a.startsWith('--'));

initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: IS_BUNDLED_EXE });

const result = await autoCompileApps({ only, force: only.length > 0 });

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

// A compile is Bun.build — it transpiles types away rather than checking them, so a
// green build says nothing about tsc. Opt-in because it is the slow half, and the
// release does not need it: CI typechecks the packages, and an app's types are the
// author's business at edit time.
const findAppPath = (appId: string): string | null =>
  APP_ROOTS.map((root) => join(root, appId)).find((p) => existsSync(join(p, 'src', 'main.ts'))) ??
  null;

let typecheckFailed = false;
if (wantTypecheck) {
  for (const appId of result.compiled.length ? result.compiled : only) {
    const appPath = findAppPath(appId);
    if (!appPath) continue;
    let bundles: string[] | undefined;
    try {
      const meta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
      if (Array.isArray(meta.bundles)) bundles = meta.bundles;
    } catch {
      // No app.json — typecheck with no gated bundles, same as the compile would.
    }
    const tc = await typecheckSandbox(appPath, { bundles });
    if (tc.success) {
      console.log('  typecheck ' + appId + ': clean');
    } else {
      typecheckFailed = true;
      console.error('  TYPECHECK ' + appId + ':\n    ' + tc.diagnostics.join('\n    '));
    }
  }
}

// A failed app compile must fail the release — shipping a half-built apps/ would leave
// broken windows in the installed product.
if (result.failed.length > 0 || typecheckFailed) process.exit(1);
