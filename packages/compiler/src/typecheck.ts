/**
 * TypeScript type checker for sandbox directories.
 *
 * Shells out to tsc --noEmit with a temporary tsconfig.
 */

import { unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { getCompilerConfig } from './config.js';
import { toForwardSlash } from './plugins.js';

export interface TypecheckResult {
  success: boolean;
  diagnostics: string[];
}

function getBundledTypesDir(): string {
  return toForwardSlash(
    resolve(getCompilerConfig().projectRoot, 'packages/compiler/src/bundled-types'),
  );
}

function getTscPath(): string {
  // tsc is a devDependency of @yaar/compiler, so resolve from this package
  return toForwardSlash(resolve(import.meta.dir, '../node_modules/.bin/tsc'));
}

/**
 * Run a loose TypeScript type check on a sandbox directory.
 *
 * Writes a temporary tsconfig, shells out to tsc --noEmit, then cleans up.
 */
export async function typecheckSandbox(sandboxPath: string): Promise<TypecheckResult> {
  // tsc is not available in bundled exe mode (no node_modules)
  if (getCompilerConfig().isBundledExe) {
    return { success: true, diagnostics: [] };
  }

  const BUNDLED_TYPES_DIR = getBundledTypesDir();
  const TSC_PATH = getTscPath();

  const tsconfigPath = join(sandboxPath, 'tsconfig.typecheck.json');

  const tsconfig = {
    compilerOptions: {
      strict: false,
      noEmit: true,
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: [],
      paths: {
        '@bundled/*': [join(BUNDLED_TYPES_DIR, '*')],
      },
      skipLibCheck: true,
    },
    files: [join(BUNDLED_TYPES_DIR, 'index.d.ts')],
    include: ['src/**/*.ts'],
  };

  await Bun.write(tsconfigPath, JSON.stringify(tsconfig, null, 2));

  try {
    const proc = Bun.spawn([TSC_PATH, '--noEmit', '-p', tsconfigPath], {
      cwd: sandboxPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => proc.kill(), 30_000);
    await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = (stdout + '\n' + stderr).trim();

    if (!output) {
      return { success: true, diagnostics: [] };
    }

    const diagnostics = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return { success: false, diagnostics };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, diagnostics: [`tsc process error: ${msg}`] };
  } finally {
    await unlink(tsconfigPath).catch(() => {});
  }
}
