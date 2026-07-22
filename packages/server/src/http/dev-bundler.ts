/**
 * Dev-mode frontend bundler with live reload.
 *
 * Builds the frontend using Bun.build(), watches for changes,
 * and notifies connected browsers via SSE to reload.
 */

import { join } from 'path';
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, watch } from 'fs';
import { PROJECT_ROOT, FRONTEND_DIST } from '../config.js';
import { errMessage } from '../lib/errors.js';
import { registerDevReloadHandler } from './server.js';

const FRONTEND_ROOT = join(PROJECT_ROOT, 'packages', 'frontend');
const FRONTEND_SRC = join(FRONTEND_ROOT, 'src');
const FRONTEND_PUBLIC = join(FRONTEND_ROOT, 'public');
// Sibling of FRONTEND_DIST (same volume, so renameSync is atomic) where each
// build is staged before being swapped into place. Git-ignored.
const FRONTEND_STAGE = FRONTEND_DIST + '.staging';

type SSEController = ReadableStreamDefaultController<Uint8Array>;
const sseClients = new Set<SSEController>();
const encoder = new TextEncoder();

/** Initialize the dev bundler: build frontend, start watcher, register SSE route. */
export async function initDevBundler(): Promise<void> {
  await scheduleBuild();
  startWatcher();
  registerDevReloadHandler(handleDevReload);
  console.log('[dev] Frontend bundler ready with live reload');
}

/** SSE endpoint handler — keeps connection open, sends reload events. */
function handleDevReload(): Response {
  let ctrl: SSEController;
  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      sseClients.add(ctrl);
      ctrl.enqueue(encoder.encode('data: connected\n\n'));
      // Bun resets any socket idle longer than its 255s transport timeout. This
      // channel is silent between rebuilds — during a quiet stretch (e.g. editing
      // apps/, which the frontend watcher ignores) it would be dropped mid-stream
      // with no terminal chunk, surfacing as net::ERR_INCOMPLETE_CHUNKED_ENCODING
      // in the console. A comment ping keeps the connection under the ceiling,
      // matching the browser-events SSE (30s) and MCP stream (60s) keepalives.
      heartbeat = setInterval(() => {
        try {
          ctrl.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(heartbeat);
          sseClients.delete(ctrl);
        }
      }, 30_000);
    },
    cancel() {
      clearInterval(heartbeat);
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

const BUNDLE_WORKER = join(import.meta.dir, 'dev-bundle-worker.ts');

/**
 * Bundle the frontend in a child process and return its output files.
 *
 * The bundle deliberately does NOT run here. `Bun.build()` shares Bun's source
 * cache with the runtime module loader, and under `bun --watch` the two get
 * cross-wired — the bundler reads a module the server has already imported (zod,
 * via @yaar/shared) and receives another file's bytes, throwing
 * `AggregateError: Bundle failed` at impossible positions. A child process
 * bundles against a cold, private cache, so a rebuild can't be poisoned by
 * whatever the long-lived server process happens to have loaded.
 */
async function runBundleWorker(
  stageDir: string,
): Promise<{ js: string[]; css: string[]; total: number }> {
  const proc = Bun.spawn(['bun', BUNDLE_WORKER, FRONTEND_SRC, stageDir], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `bundle worker exited with code ${exitCode}`);
  }
  return JSON.parse(stdout) as { js: string[]; css: string[]; total: number };
}

/**
 * Build the frontend, tolerating failures.
 *
 * A dev-only hot-reload rebuild must never take the server down. Since the top-
 * level `unhandledRejection` handler in main.ts triggers a full shutdown, we
 * MUST NOT let this promise reject. Swallow the error, log it (the worker's
 * stderr carries the real syntax/import errors), and retry once so a rebuild
 * that lost a race with a half-saved file recovers on its own.
 *
 * Never call this directly — go through `scheduleBuild()`. Two builds overlapping
 * would stage into the same directory and delete each other's output mid-build.
 */
async function buildFrontend(retry: boolean): Promise<void> {
  try {
    await buildFrontendInner();
  } catch (err) {
    const msg = errMessage(err);
    console.error(
      `[dev] Frontend rebuild failed — server stays up${retry ? ', retrying…' : ''}\n${msg}`,
    );
    rmSync(FRONTEND_STAGE, { recursive: true, force: true });
    if (retry) {
      // Let a half-written file land, then rebuild.
      setTimeout(() => scheduleBuild({ retry: false }), 300);
    }
  }
}

/** The in-flight build, if any, plus whether another was requested during it. */
let activeBuild: Promise<void> | null = null;
let rebuildQueued = false;

/**
 * Run a build, coalescing concurrent requests. A request that arrives mid-build
 * is collapsed into a single follow-up run rather than starting a second
 * `Bun.build()` alongside the first.
 */
function scheduleBuild({ retry = true }: { retry?: boolean } = {}): Promise<void> {
  if (activeBuild) {
    rebuildQueued = true;
    return activeBuild;
  }
  activeBuild = buildFrontend(retry).finally(() => {
    activeBuild = null;
    if (rebuildQueued) {
      rebuildQueued = false;
      void scheduleBuild();
    }
  });
  return activeBuild;
}
async function buildFrontendInner(): Promise<void> {
  const start = performance.now();

  // Build into a fresh temp dir and only swap it into place on success, so a
  // failed rebuild (including a transient `bun --watch` bundler-cache throw)
  // leaves the last good build serving instead of an empty dist.
  const stageDir = FRONTEND_STAGE;
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const { js: jsFiles, css: cssFiles, total } = await runBundleWorker(stageDir);

  // Copy public files (fonts)
  cpSync(FRONTEND_PUBLIC, stageDir, { recursive: true });

  // Generate index.html with live-reload script. Output URLs are relative to the
  // dist root, and the worker already made them so (same layout once swapped).
  const html = generateDevHtml(jsFiles, cssFiles);
  await Bun.write(join(stageDir, 'index.html'), html);

  // Atomically swap the freshly built dist into place.
  rmSync(FRONTEND_DIST, { recursive: true, force: true });
  renameSync(stageDir, FRONTEND_DIST);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[dev] Frontend built in ${elapsed}ms (${total} files)`);

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

/**
 * Content fingerprint (size + mtime per file) of the public/ tree.
 *
 * Every build copies public/ into the staging dir, and on macOS *reading* a file
 * bumps its inode metadata, which FSEvents reports as a `change` — so the copy
 * trips public/'s own watcher and the build re-triggers itself, forever. mtime
 * and size don't move when a file is merely read, so comparing this fingerprint
 * tells a real font edit apart from the echo of our own copy.
 */
function publicSignature(): string {
  const names = readdirSync(FRONTEND_PUBLIC, { recursive: true }) as string[];
  return names
    .sort()
    .map((name) => {
      try {
        const s = statSync(join(FRONTEND_PUBLIC, name));
        return `${name}:${s.size}:${s.mtimeMs}`;
      } catch {
        return `${name}:gone`;
      }
    })
    .join('|');
}

let lastPublicSignature = '';

function startWatcher(): void {
  lastPublicSignature = publicSignature();

  watch(FRONTEND_SRC, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Skip test files
    if (filename.endsWith('.test.ts') || filename.endsWith('.test.tsx')) return;

    // Debounce rapid changes (e.g. editor save + format)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void scheduleBuild(), 150);
  });

  // Also watch public files (fonts, etc.)
  watch(FRONTEND_PUBLIC, { recursive: true }, () => {
    const signature = publicSignature();
    if (signature === lastPublicSignature) return; // our own copy reading public/, not an edit
    lastPublicSignature = signature;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void scheduleBuild(), 150);
  });
}
