/**
 * Where this package's own files live at runtime.
 *
 * Three consumers need a path *into the compiler package* rather than into the
 * app being built: the shim sources handed to `Bun.build()`, the `.d.ts` the
 * agent-facing library description slices, and the directory `Bun.resolveSync`
 * resolves bundled devDependencies from. Each used to re-derive it from its own
 * `import.meta.url`, in two different spellings of the same src/dist trick — so
 * moving a module changed what it could find.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** Normalize a path to forward slashes; see `toForwardSlash` in `bundled/registry.ts`. */
const fwd = (p: string): string => p.replace(/\\/g, '/');

/**
 * The root of this package's module tree: `src/` under `bun`/tsx, `dist/` once
 * built. This file sits directly in it, which is the whole reason it is here and
 * not in a subdirectory.
 */
export const MODULE_ROOT = fwd(dirname(fileURLToPath(import.meta.url)));

/** `packages/compiler` — where the bundled libraries are installed as devDependencies. */
export const PACKAGE_ROOT = fwd(join(MODULE_ROOT, '..'));

/**
 * Shim sources. Always under `src/`, never `dist/`: shims are `.ts` files that
 * `Bun.build()` consumes as *source*, so the built copy is not what we want.
 */
export const SHIMS_DIR = fwd(join(PACKAGE_ROOT, 'src', 'shims'));

/** The ambient declarations for every `@bundled/*` module. Also src-only. */
export const BUNDLED_TYPES_DTS = fwd(join(PACKAGE_ROOT, 'src', 'bundled-types', 'index.d.ts'));
