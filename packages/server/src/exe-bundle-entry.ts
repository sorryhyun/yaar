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
 * The tail is an async IIFE rather than a top-level `await` because the exe is built with
 * `--bytecode`, which emits CommonJS, where top-level `await` is a syntax error. The
 * ordering that matters is unchanged: everything above the call is synchronous, so it has
 * all run by the time `import()` is invoked. What a top-level `await` gave us for free was
 * a loud crash if boot threw, so the `catch` below restores that explicitly.
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

void (async () => {
  try {
    await import('./exe-entry.js');
  } catch (err) {
    console.error('[yaar] failed to start:', err);
    process.exit(1);
  }
})();
