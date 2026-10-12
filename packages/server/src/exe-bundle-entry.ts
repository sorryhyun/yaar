/**
 * Entry point for `bun build --compile` — the standalone executable's first module.
 *
 * It exists to run three things *before* any server code loads, which is the whole reason
 * `exe-entry.ts` is reached through a dynamic `import()` down at the bottom: static imports
 * are hoisted and evaluated first, so a server module imported statically here would read
 * these globals before they were set.
 *
 * This used to be `_build-entry.generated.ts` — written by `scripts/build/exe-bundle.js` on
 * every build, thousands of lines long, deleted in a `finally`. `bun build --asset` embeds
 * directories directly, so the file that survives is this one: checked in, readable, and
 * the same on every build. It is excluded from `tsconfig.build.json` for the same reason
 * the tests are — it belongs to the exe, not to `dist/`.
 *
 * The tail is a top-level `await`, which needs the ESM bytecode build (`--format=esm` in
 * `scripts/build/exe-bundle.js`): under the CommonJS `--bytecode` emits by default it is a
 * syntax error. The `catch` names the failure, so a boot that throws says so before it exits.
 */

// The AST protocol extractor is the exe's only reader of an `app.register()` protocol, and
// `protocol/load-typescript.ts` hides its own import from the bundler (typescript is a
// devDependency that may be absent in a plain server install). This static import is
// therefore what compiles the compiler into the binary; without it, apps that declare their
// protocol in code are refused rather than guessed at.
import * as ts from 'typescript';

import { installEmbeddedAssetMaps } from './exe-assets.js';

(globalThis as Record<string, unknown>).__YAAR_TYPESCRIPT =
  (ts as unknown as { default?: unknown }).default ?? ts;

installEmbeddedAssetMaps();

try {
  // `yaar --window <url>` is the exe re-spawned to own the desktop window, not a second
  // server: route it away before any server module loads (desktop-window/host.ts).
  if (process.argv.includes('--window')) {
    const { runWindowProcess } = await import('./desktop-window/host.js');
    runWindowProcess(process.argv);
  }
  // `yaar --pick-directory` is the Windows folder-picker helper: show the dialog, print one
  // JSON line, exit (features/pick-directory.ts spawns it).
  if (process.argv.includes('--pick-directory')) {
    const { runFolderDialogProcess } = await import('@yaar/lib/win32');
    runFolderDialogProcess();
  }
  const { seedBundledApps } = await import('./macos-bundle.js');
  seedBundledApps();
  await import('./exe-entry.js');
} catch (err) {
  console.error('[yaar] failed to start:', err);
  process.exit(1);
}
