/**
 * TypeScript type checker for sandbox directories.
 *
 * Shells out to tsc --noEmit with a temporary tsconfig.
 */

import { readFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { getCompilerConfig } from './config.js';
import { loadTypeScript } from './load-typescript.js';
import { scanProjectGuards } from './guards/scan-project.js';
import { PACKAGE_ROOT } from './paths.js';
import { readThreeRenderer, type ThreeRenderer } from './bundled/three-renderer.js';
import {
  BUNDLED_TYPES_DIR,
  SANDBOX_INCLUDE,
  sandboxCompilerOptions,
  sliceBundledTypes,
} from './sandbox-tsconfig.js';

export interface TypecheckResult {
  success: boolean;
  diagnostics: string[];
}

export interface TypecheckOptions {
  bundles?: string[];
}

function getTscPath(): string {
  // Drive the JS entry through Bun. Spawning node_modules/.bin/tsc directly
  // under Bun can exit 0 without executing the shebang target.
  return join(PACKAGE_ROOT, 'node_modules/typescript/lib/tsc.js');
}

/**
 * Write the bundled declarations sliced to the app's grants, returning the path
 * to hand tsc — the canonical file itself when nothing needs slicing.
 *
 * Without `typescript` there is nothing to slice the declarations with, so the
 * canonical file stands — the same conservative answer exe mode already gives,
 * where `typecheckSandbox` returns before ever reaching here. The tsconfig's
 * `paths` still points every denied bundle at a directory that does not exist.
 */
async function writeAllowedBundledTypes(
  sourcePath: string,
  allowedBundles: string[],
  three: ThreeRenderer,
): Promise<string> {
  const ts = await loadTypeScript();
  if (!ts) return sourcePath;

  const sliced = sliceBundledTypes(ts, await readFile(sourcePath, 'utf8'), allowedBundles, three);
  if (sliced === null) return sourcePath;

  // Keep the sliced view under the compiler package so its re-exports resolve
  // against the compiler's node_modules, not the app sandbox's dependency tree.
  const outputPath = join(PACKAGE_ROOT, `.yaar-bundled-types.${crypto.randomUUID()}.d.ts`);
  await Bun.write(outputPath, sliced);
  return outputPath;
}

/**
 * Run a loose TypeScript type check on a sandbox directory.
 *
 * Writes a temporary tsconfig, shells out to tsc --noEmit, then cleans up.
 *
 * The source guards ride along. They are what `compile` enforces from inside the
 * bundler's `onLoad` hook, which means they only speak once a build runs — after
 * the code is written, and after a second file has repeated the same mistake.
 * Both are purely syntactic, so there is no reason for the earlier, cheaper call
 * to stay silent about them.
 */
export async function typecheckSandbox(
  sandboxPath: string,
  options: TypecheckOptions = {},
): Promise<TypecheckResult> {
  // tsc is not available in bundled exe mode (no node_modules)
  if (getCompilerConfig().isBundledExe) {
    return { success: true, diagnostics: [] };
  }

  const guardDiagnostics = await scanProjectGuards(sandboxPath);

  const TSC_PATH = getTscPath();
  const bundledTypesSource = join(BUNDLED_TYPES_DIR, 'index.d.ts');
  const sandboxRoot = resolve(sandboxPath);

  // Unique per invocation — concurrent typechecks on the same sandbox must not
  // overwrite or unlink each other's config while tsc is reading it.
  const tsconfigPath = join(sandboxRoot, `tsconfig.typecheck.${crypto.randomUUID()}.json`);

  const three = readThreeRenderer(sandboxRoot);
  const bundledTypesPath = await writeAllowedBundledTypes(
    bundledTypesSource,
    options.bundles ?? [],
    three,
  );
  const tsconfig = {
    compilerOptions: sandboxCompilerOptions(options.bundles, three),
    files: [bundledTypesPath],
    include: SANDBOX_INCLUDE,
  };

  await Bun.write(tsconfigPath, JSON.stringify(tsconfig, null, 2));

  try {
    const proc = Bun.spawn([process.execPath, TSC_PATH, '--noEmit', '-p', tsconfigPath], {
      cwd: sandboxRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const output = (stdout + '\n' + stderr).trim();

    if (exitCode === 0) {
      // Guard findings alone still fail: each one is a build error waiting to
      // happen, and reporting them under `success: true` would let deploy ship
      // an app that cannot compile.
      return { success: guardDiagnostics.length === 0, diagnostics: guardDiagnostics };
    }

    const diagnostics = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (diagnostics.length === 0) diagnostics.push(`tsc exited with code ${exitCode}`);

    return { success: false, diagnostics: [...guardDiagnostics, ...diagnostics] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, diagnostics: [...guardDiagnostics, `tsc process error: ${msg}`] };
  } finally {
    await unlink(tsconfigPath).catch(() => {});
    if (bundledTypesPath !== bundledTypesSource) await unlink(bundledTypesPath).catch(() => {});
  }
}
