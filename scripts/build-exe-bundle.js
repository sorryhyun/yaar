#!/usr/bin/env bun
/**
 * Build standalone executable with frontend assets embedded via Bun.
 *
 * Usage:
 *   bun scripts/build-exe-bundle.js --target windows
 *   bun scripts/build-exe-bundle.js --target linux
 *
 * Generates a temporary entry point that imports all frontend dist files
 * and pre-bundled libraries using `with { type: "file" }`, which tells Bun
 * to embed them as-is (without parsing HTML/CSS/JS). At runtime they're
 * accessible via `Bun.embeddedFiles`. The resulting executable is fully
 * self-contained with app development support built in.
 *
 * Provider is selected at runtime via config/settings.json or PROVIDER env var.
 */

import { execSync } from 'child_process';
import { readdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// ── Parse CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const target = getArg('target') ?? 'linux';

const arch = getArg('arch') ?? 'x64';

const bunTargets = {
  'windows-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'macos-x64': 'bun-darwin-x64',
  'macos-arm64': 'bun-darwin-arm64',
};

const key = `${target}-${arch}`;
const bunTarget = bunTargets[key];
if (!bunTarget) {
  console.error(`Invalid target/arch: ${key}. Valid combinations: ${Object.keys(bunTargets).join(', ')}`);
  process.exit(1);
}

const ext = target === 'windows' ? '.exe' : '';
const exeName = 'yaar';
const outfile = join(rootDir, 'dist', `${exeName}${ext}`);

// ── Collect frontend dist files ──────────────────────────────────────

const frontendDist = join(rootDir, 'packages', 'frontend', 'dist');

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

let frontendFiles;
try {
  frontendFiles = collectFiles(frontendDist);
} catch {
  console.error(`Frontend dist not found at ${frontendDist}`);
  console.error('Run "bun run build" first.');
  process.exit(1);
}

console.log(`Embedding ${frontendFiles.length} frontend files into executable...`);

// ── Collect pre-bundled library files ────────────────────────────────

const bundledLibsDir = join(rootDir, 'dist', 'bundled-libs');
let bundledLibFiles = [];

/** Recursively collect .js files, returning library names with subdirectory paths (e.g. "solid-js/html"). */
function collectLibFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectLibFiles(full, prefix ? `${prefix}/${entry.name}` : entry.name));
    } else if (entry.name.endsWith('.js')) {
      const name = prefix ? `${prefix}/${basename(entry.name, '.js')}` : basename(entry.name, '.js');
      results.push({ name, absPath: full });
    }
  }
  return results;
}

if (existsSync(bundledLibsDir)) {
  bundledLibFiles = collectLibFiles(bundledLibsDir);
  console.log(`Embedding ${bundledLibFiles.length} bundled libraries...`);
} else {
  console.warn('Warning: dist/bundled-libs/ not found. Run "bun run build:exe:libs" first.');
  console.warn('Bundled exe will not be able to resolve @bundled/* imports at runtime.');
}

// ── Collect onnxruntime-web runtime artifacts ────────────────────────
//
// The @bundled/yaar-ml SDK loads ORT from the server's /api/ml-runtime/ route. A
// standalone exe has no node_modules to serve that from, so the artifacts ride
// inside the binary like the frontend does. Only the three files the shim actually
// pins are embedded — dist/ as a whole is 129MB of variants (jspi/webgl/node/all)
// nothing here loads.
//
// Keep this list in sync with packages/compiler/src/shims/yaar-ml.ts:
//   ORT_URL                  → ort.webgpu.bundle.min.mjs   (the module the app imports)
//   ort.env.wasm.wasmPaths   → the .mjs glue + .wasm the bundle fetches at runtime
const ML_RUNTIME_ARTIFACTS = [
  'ort.webgpu.bundle.min.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

function resolveMlRuntimeDir() {
  // onnxruntime-web is a dependency of @yaar/server, so resolve from there — Bun
  // stores it under node_modules/.bun/ and only symlinks it into the package that
  // declares it, which means resolving from the repo root fails.
  const from = join(rootDir, 'packages', 'server');
  const pkgJson = Bun.resolveSync('onnxruntime-web/package.json', from);
  return join(dirname(pkgJson), 'dist');
}

let mlRuntimeFiles;
try {
  const mlDist = resolveMlRuntimeDir();
  mlRuntimeFiles = ML_RUNTIME_ARTIFACTS.map((name) => {
    const absPath = join(mlDist, name);
    if (!existsSync(absPath)) {
      throw new Error(`missing ${name} in ${mlDist}`);
    }
    return { name, absPath };
  });
  console.log(`Embedding ${mlRuntimeFiles.length} ML runtime artifacts (~24MB)...`);
} catch (err) {
  // Hard failure, not a warning. A binary without these silently 404s every
  // /api/ml-runtime/ request, and the only symptom is a blank window in whatever
  // app declared "bundles": ["yaar-ml"] — which is how this shipped unnoticed once.
  console.error(`Cannot locate the onnxruntime-web runtime artifacts: ${err.message}`);
  console.error('Run "bun install" first (onnxruntime-web is a dependency of @yaar/server).');
  process.exit(1);
}

// ── Generate temporary entry point ──────────────────────────────────

const generatedEntry = join(rootDir, 'packages', 'server', 'src', '_build-entry.generated.ts');
const serverSrcDir = join(rootDir, 'packages', 'server', 'src');

// Build import lines for each frontend file using { type: "file" }
// so Bun embeds them as-is without parsing HTML/CSS/JS.
// Each import returns a /$bunfs/ path at runtime; we map URL paths to these.
const importLines = [];
const mapEntries = [];

frontendFiles.forEach((absPath, i) => {
  // Relative path from generated file to frontend file (posix separators)
  const rel = relative(serverSrcDir, absPath).split('\\').join('/');
  const importPath = rel.startsWith('.') ? rel : `./${rel}`;
  importLines.push(`import _f${i} from ${JSON.stringify(importPath)} with { type: "file" };`);

  // URL path: strip frontendDist prefix → e.g. "/index.html", "/assets/index-xxx.js"
  const urlPath = '/' + relative(frontendDist, absPath).split('\\').join('/');
  mapEntries.push(`  ${JSON.stringify(urlPath)}: _f${i},`);
});

// Build import lines for each bundled library file
const libImportLines = [];
const libMapEntries = [];

bundledLibFiles.forEach(({ name, absPath }, i) => {
  const rel = relative(serverSrcDir, absPath).split('\\').join('/');
  const importPath = rel.startsWith('.') ? rel : `./${rel}`;
  libImportLines.push(`import _lib${i} from ${JSON.stringify(importPath)} with { type: "file" };`);
  libMapEntries.push(`  ${JSON.stringify(name)}: _lib${i},`);
});

// Build import lines for each ML runtime artifact. `type: "file"` is what keeps the
// .mjs ones intact — ORT's loader re-enters itself as a worker from its own script
// URL, so it has to be served as-is rather than parsed and rebundled here.
const mlImportLines = [];
const mlMapEntries = [];

mlRuntimeFiles.forEach(({ name, absPath }, i) => {
  const rel = relative(serverSrcDir, absPath).split('\\').join('/');
  const importPath = rel.startsWith('.') ? rel : `./${rel}`;
  mlImportLines.push(`import _ml${i} from ${JSON.stringify(importPath)} with { type: "file" };`);
  mlMapEntries.push(`  ${JSON.stringify(name)}: _ml${i},`);
});

const generatedSource = [
  '// @ts-nocheck',
  '// Auto-generated by build-exe-bundle.js — do not edit',
  '',
  ...importLines,
  ...libImportLines,
  ...mlImportLines,
  '',
  '// Embed the `typescript` module so the AST protocol extractor runs in the exe.',
  '// load-typescript.ts hides its own import from the bundler (typescript is a',
  '// devDependency that may be absent in a plain server install), so a static',
  '// import here is what forces Bun to compile it into the binary. Without it the',
  '// exe could not read an `app.register()` protocol at all: the AST extractor is',
  '// its only reader, and without it those apps are refused rather than guessed at.',
  "import * as __ts from 'typescript';",
  '',
  '// Set globals BEFORE importing server code.',
  '// Using dynamic import() for exe-entry ensures these assignments',
  '// run first — static imports execute before the module body.',
  '',
  '(globalThis as any).__YAAR_TYPESCRIPT = __ts.default ?? __ts;',
  '',
  '// Map URL paths to embedded file paths (/$bunfs/root/...)',
  '(globalThis as any).__YAAR_EMBEDDED_FRONTEND = {',
  ...mapEntries,
  '};',
  '',
  ...(libMapEntries.length > 0 ? [
    '// Map library names to embedded file paths for @bundled/* resolution',
    '(globalThis as any).__YAAR_BUNDLED_LIBS = {',
    ...libMapEntries,
    '};',
    '',
  ] : []),
  '// Map ORT artifact names to embedded file paths, served at /api/ml-runtime/',
  '(globalThis as any).__YAAR_ML_RUNTIME = {',
  ...mlMapEntries,
  '};',
  '',
  `await import('./exe-entry.js');`,
  '',
].join('\n');

writeFileSync(generatedEntry, generatedSource, 'utf-8');

// ── Build ────────────────────────────────────────────────────────────

const entrypoint = relative(rootDir, generatedEntry);
const defines = ['--define', '__YAAR_BUNDLED=true'];

const cmd = [
  'bun', 'build',
  entrypoint,
  '--compile',
  `--target=${bunTarget}`,
  `--outfile=${relative(rootDir, outfile)}`,
  '--minify',
  '--external', 'cpu-features',
  ...defines,
].join(' ');

console.log(`Running: ${cmd.slice(0, 140)}...`);

try {
  execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
  console.log(`\nBuilt: ${outfile}`);
} finally {
  // Clean up generated entry point
  try { unlinkSync(generatedEntry); } catch { /* ignore */ }
}
