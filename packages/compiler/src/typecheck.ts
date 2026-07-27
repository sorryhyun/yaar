/**
 * TypeScript type checker for sandbox directories.
 *
 * Shells out to tsc --noEmit with a temporary tsconfig.
 */

import { readFile, unlink } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { getCompilerConfig } from './config.js';
import { GATED_BUNDLED_LIBRARIES, toForwardSlash } from './plugins.js';
import { loadTypeScript } from './load-typescript.js';

export interface TypecheckResult {
  success: boolean;
  diagnostics: string[];
}

export interface TypecheckOptions {
  bundles?: string[];
}

function getBundledTypesDir(): string {
  return toForwardSlash(
    resolve(getCompilerConfig().projectRoot, 'packages/compiler/src/bundled-types'),
  );
}

function getTscPath(): string {
  // Drive the JS entry through Bun. Spawning node_modules/.bin/tsc directly
  // under Bun can exit 0 without executing the shebang target.
  return toForwardSlash(resolve(import.meta.dir, '../node_modules/typescript/lib/tsc.js'));
}

async function writeAllowedBundledTypes(
  sourcePath: string,
  allowedBundles: string[],
): Promise<string> {
  const denied = new Set(
    GATED_BUNDLED_LIBRARIES.filter((bundle) => !allowedBundles.includes(bundle)),
  );
  if (denied.size === 0) return sourcePath;

  // Keep one canonical declaration file for docs and editor tooling. For a
  // sandbox typecheck, remove only ambient modules the app did not opt into.
  // Without `typescript` there is nothing to slice the declarations with, so the
  // canonical file stands — the same conservative answer exe mode already gives,
  // where `typecheckSandbox` returns before ever reaching here. The tsconfig's
  // `paths` still points every denied bundle at a directory that does not exist.
  const ts = await loadTypeScript();
  if (!ts) return sourcePath;

  const source = await readFile(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ranges = sourceFile.statements
    .filter(
      (statement): statement is import('typescript').ModuleDeclaration =>
        ts.isModuleDeclaration(statement) &&
        ts.isStringLiteral(statement.name) &&
        statement.name.text.startsWith('@bundled/') &&
        denied.has(statement.name.text.slice('@bundled/'.length)),
    )
    .map((statement) => ({ start: statement.getStart(sourceFile), end: statement.end }))
    .sort((a, b) => b.start - a.start);

  let filtered = source;
  for (const range of ranges) filtered = filtered.slice(0, range.start) + filtered.slice(range.end);

  // Keep the filtered view under the compiler package so its re-exports resolve
  // against the compiler's node_modules, not the app sandbox's dependency tree.
  const compilerRoot = resolve(dirname(sourcePath), '../..');
  const outputPath = join(compilerRoot, `.yaar-bundled-types.${crypto.randomUUID()}.d.ts`);
  await Bun.write(outputPath, filtered);
  return outputPath;
}

/**
 * Run a loose TypeScript type check on a sandbox directory.
 *
 * Writes a temporary tsconfig, shells out to tsc --noEmit, then cleans up.
 */
export async function typecheckSandbox(
  sandboxPath: string,
  options: TypecheckOptions = {},
): Promise<TypecheckResult> {
  // tsc is not available in bundled exe mode (no node_modules)
  if (getCompilerConfig().isBundledExe) {
    return { success: true, diagnostics: [] };
  }

  const BUNDLED_TYPES_DIR = getBundledTypesDir();
  const TSC_PATH = getTscPath();
  const bundledTypesSource = join(BUNDLED_TYPES_DIR, 'index.d.ts');
  const sandboxRoot = resolve(sandboxPath);
  let bundledTypesPath: string | null = null;

  // Unique per invocation — concurrent typechecks on the same sandbox must not
  // overwrite or unlink each other's config while tsc is reading it.
  const tsconfigPath = join(sandboxRoot, `tsconfig.typecheck.${crypto.randomUUID()}.json`);

  bundledTypesPath = await writeAllowedBundledTypes(bundledTypesSource, options.bundles ?? []);
  const deniedBundlePaths = Object.fromEntries(
    GATED_BUNDLED_LIBRARIES.filter((bundle) => !options.bundles?.includes(bundle)).map((bundle) => [
      `@bundled/${bundle}`,
      [join(BUNDLED_TYPES_DIR, '__bundle-not-enabled__', bundle)],
    ]),
  );

  const tsconfig = {
    compilerOptions: {
      strict: false,
      noEmit: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: [],
      paths: {
        ...deniedBundlePaths,
        '@bundled/*': [join(BUNDLED_TYPES_DIR, '*')],
      },
      skipLibCheck: true,
    },
    files: [bundledTypesPath],
    include: ['src/**/*.ts'],
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
      return { success: true, diagnostics: [] };
    }

    const diagnostics = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (diagnostics.length === 0) diagnostics.push(`tsc exited with code ${exitCode}`);

    return { success: false, diagnostics };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, diagnostics: [`tsc process error: ${msg}`] };
  } finally {
    await unlink(tsconfigPath).catch(() => {});
    if (bundledTypesPath !== bundledTypesSource) await unlink(bundledTypesPath).catch(() => {});
  }
}
