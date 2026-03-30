/**
 * Dev-mode frontend bundler with live reload.
 *
 * Builds the frontend using Bun.build(), watches for changes,
 * and notifies connected browsers via SSE to reload.
 */

import { join, relative } from 'path';
import { cpSync, mkdirSync, rmSync, watch } from 'fs';
import { PROJECT_ROOT, FRONTEND_DIST } from '../config.js';
import { registerDevReloadHandler } from './server.js';

const FRONTEND_ROOT = join(PROJECT_ROOT, 'packages', 'frontend');
const FRONTEND_SRC = join(FRONTEND_ROOT, 'src');
const FRONTEND_PUBLIC = join(FRONTEND_ROOT, 'public');

type SSEController = ReadableStreamDefaultController<Uint8Array>;
const sseClients = new Set<SSEController>();
const encoder = new TextEncoder();

let building = false;
let pendingRebuild = false;

/** Initialize the dev bundler: build frontend, start watcher, register SSE route. */
export async function initDevBundler(): Promise<void> {
  await buildFrontend();
  startWatcher();
  registerDevReloadHandler(handleDevReload);
  console.log('[dev] Frontend bundler ready with live reload');
}

/** SSE endpoint handler — keeps connection open, sends reload events. */
function handleDevReload(): Response {
  let ctrl: SSEController;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      sseClients.add(ctrl);
      ctrl.enqueue(encoder.encode('data: connected\n\n'));
    },
    cancel() {
      sseClients.delete(ctrl);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/** Resolve @/ path alias and handle CSS url() references. */
const pathAliasPlugin: import('bun').BunPlugin = {
  name: 'frontend-resolve',
  setup(build) {
    // Resolve @/ imports with proper extension/index resolution
    build.onResolve({ filter: /^@\// }, async (args) => {
      const basePath = join(FRONTEND_SRC, args.path.slice(2));
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
  for (const ext of EXTENSIONS) {
    if (await Bun.file(basePath + ext).exists()) return basePath + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexPath = join(basePath, 'index' + ext);
    if (await Bun.file(indexPath).exists()) return indexPath;
  }
  return basePath;
}

async function buildFrontend(): Promise<void> {
  const start = performance.now();

  rmSync(FRONTEND_DIST, { recursive: true, force: true });
  mkdirSync(FRONTEND_DIST, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(FRONTEND_SRC, 'main.tsx')],
    outdir: FRONTEND_DIST,
    target: 'browser',
    splitting: true,
    sourcemap: 'linked',
    naming: '[dir]/[name]-[hash].[ext]',
    plugins: [pathAliasPlugin],
  });

  if (!result.success) {
    console.error('[dev] Frontend build failed:');
    for (const log of result.logs) {
      console.error(log);
    }
    return;
  }

  // Copy public files (fonts)
  cpSync(FRONTEND_PUBLIC, FRONTEND_DIST, { recursive: true });

  // Generate index.html with live-reload script
  const jsFiles = result.outputs
    .filter((o) => o.kind === 'entry-point' && o.path.endsWith('.js'))
    .map((o) => '/' + relative(FRONTEND_DIST, o.path));

  const cssFiles = result.outputs
    .filter((o) => o.path.endsWith('.css'))
    .map((o) => '/' + relative(FRONTEND_DIST, o.path));

  const html = generateDevHtml(jsFiles, cssFiles);
  await Bun.write(join(FRONTEND_DIST, 'index.html'), html);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[dev] Frontend built in ${elapsed}ms (${result.outputs.length} files)`);

  // Notify SSE clients to reload
  notifyClients();
}

function generateDevHtml(jsFiles: string[], cssFiles: string[]): string {
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
    <script>new EventSource('/dev-reload').onmessage = e => { if (e.data === 'reload') location.reload(); };</script>
  </body>
</html>`;
}

function notifyClients(): void {
  const msg = encoder.encode('data: reload\n\n');
  for (const client of sseClients) {
    try {
      client.enqueue(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function startWatcher(): void {
  watch(FRONTEND_SRC, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Skip test files
    if (filename.endsWith('.test.ts') || filename.endsWith('.test.tsx')) return;

    // Debounce rapid changes (e.g. editor save + format)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (building) {
        pendingRebuild = true;
        return;
      }
      building = true;
      try {
        await buildFrontend();
      } finally {
        building = false;
        if (pendingRebuild) {
          pendingRebuild = false;
          buildFrontend();
        }
      }
    }, 150);
  });

  // Also watch public files (fonts, etc.)
  watch(FRONTEND_PUBLIC, { recursive: true }, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!building) buildFrontend();
    }, 150);
  });
}
