/**
 * Production build script using Bun's bundler.
 * Replaces Vite for building the frontend.
 *
 * Usage: bun packages/frontend/build.ts
 */

import { join, relative } from 'path';
import { cpSync, mkdirSync, rmSync } from 'fs';

const ROOT = import.meta.dirname;
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const PUBLIC = join(ROOT, 'public');

async function build() {
  const start = performance.now();

  // Clean dist
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(SRC, 'main.tsx')],
    outdir: DIST,
    target: 'browser',
    minify: true,
    splitting: true,
    sourcemap: 'linked',
    naming: '[dir]/[name]-[hash].[ext]',
    plugins: [pathAliasPlugin],
  });

  if (!result.success) {
    console.error('Build failed:');
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Copy public files (fonts, etc.)
  cpSync(PUBLIC, DIST, { recursive: true });

  // Generate index.html
  const jsFiles = result.outputs
    .filter((o) => o.kind === 'entry-point' && o.path.endsWith('.js'))
    .map((o) => '/' + relative(DIST, o.path));

  const cssFiles = result.outputs
    .filter((o) => o.path.endsWith('.css'))
    .map((o) => '/' + relative(DIST, o.path));

  const html = generateHtml(jsFiles, cssFiles);
  await Bun.write(join(DIST, 'index.html'), html);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`Built ${result.outputs.length} files to dist/ in ${elapsed}ms`);
}

/** Resolve @/ path alias and handle CSS url() references. */
const pathAliasPlugin: import('bun').BunPlugin = {
  name: 'frontend-resolve',
  setup(build) {
    // Resolve @/ imports with proper extension/index resolution
    build.onResolve({ filter: /^@\// }, async (args) => {
      const basePath = join(SRC, args.path.slice(2));
      return { path: await resolveFile(basePath) };
    });

    // Leave absolute URL references in CSS as-is (fonts served from public/)
    build.onResolve(
      { filter: /^\/.+\.(otf|ttf|woff|woff2|eot|png|jpg|jpeg|gif|svg|ico|webp)$/ },
      (args) => ({ path: args.path, external: true }),
    );
  },
};

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

async function resolveFile(basePath: string): Promise<string> {
  // Try direct with extensions
  for (const ext of EXTENSIONS) {
    if (await Bun.file(basePath + ext).exists()) return basePath + ext;
  }
  // Try as directory with index
  for (const ext of EXTENSIONS) {
    const indexPath = join(basePath, 'index' + ext);
    if (await Bun.file(indexPath).exists()) return indexPath;
  }
  return basePath;
}

export function generateHtml(
  jsFiles: string[],
  cssFiles: string[],
  extraScripts = '',
): string {
  const cssLinks = cssFiles.map((f) => `    <link rel="stylesheet" href="${f}" />`).join('\n');
  const jsScripts = jsFiles.map((f) => `    <script type="module" src="${f}"></script>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en" translate="no">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google" content="notranslate" />
    <title>YAAR</title>
${cssLinks}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body, #root { width: 100%; height: 100%; overflow: hidden; font-family: var(--font-sans); }
      html.yaar-dragging iframe { pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="root"></div>
${jsScripts}
${extraScripts}
  </body>
</html>`;
}

build();
