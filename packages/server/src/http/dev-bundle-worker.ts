/**
 * Frontend bundler, run as a child process by dev-bundler.ts.
 *
 * This exists as a separate process on purpose. `Bun.build()` shares Bun's
 * source cache with the runtime module loader, and under `bun --watch` that
 * cache gets cross-wired: the bundler asks for a module the server has already
 * imported (zod, via @yaar/shared) and is handed another file's bytes, failing
 * with `AggregateError: Bundle failed` and nonsense positions like
 * `zod/index.js:16`. A fresh process has a cold, private cache, so the build is
 * deterministic no matter what the server happens to have loaded.
 *
 * Usage:  bun dev-bundle-worker.ts <frontendSrcDir> <outDir>
 * Output: JSON { js, css, total } on stdout. `js`/`css` are the entry files the
 * dev HTML must link (paths relative to outDir); every output — including shared
 * chunks and sourcemaps — is written to outDir by Bun.build itself.
 */

import { join, relative } from 'path';

const [frontendSrc, outDir] = process.argv.slice(2);
if (!frontendSrc || !outDir) {
  console.error('usage: dev-bundle-worker.ts <frontendSrcDir> <outDir>');
  process.exit(2);
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

async function resolveFile(basePath: string): Promise<string> {
  for (const ext of EXTENSIONS) {
    if (await Bun.file(basePath + ext).exists()) return basePath + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexPath = join(basePath, 'index' + ext);
    if (await Bun.file(indexPath).exists()) return indexPath;
  }
  return basePath;
}

/** Resolve @/ path alias and leave CSS url() asset references external. */
const pathAliasPlugin: import('bun').BunPlugin = {
  name: 'frontend-resolve',
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveFile(join(frontendSrc, args.path.slice(2))),
    }));

    build.onResolve(
      { filter: /^\/.+\.(otf|ttf|woff|woff2|eot|png|jpg|jpeg|gif|svg|ico|webp)$/ },
      (args) => ({ path: args.path, external: true }),
    );
  },
};

const result = await Bun.build({
  entrypoints: [join(frontendSrc, 'main.tsx')],
  outdir: outDir,
  target: 'browser',
  splitting: true,
  // Kept in step with packages/frontend/build.ts: dev must compile the same way
  // prod does, or a React Compiler behavior change only ever shows up in a release.
  reactCompiler: true,
  sourcemap: 'linked',
  naming: '[dir]/[name]-[hash].[ext]',
  plugins: [pathAliasPlugin],
});

const js = result.outputs
  .filter((o) => o.kind === 'entry-point' && o.path.endsWith('.js'))
  .map((o) => '/' + relative(outDir, o.path));

const css = result.outputs
  .filter((o) => o.path.endsWith('.css'))
  .map((o) => '/' + relative(outDir, o.path));

console.log(JSON.stringify({ js, css, total: result.outputs.length }));
