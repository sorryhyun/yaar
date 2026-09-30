#!/usr/bin/env bun
/**
 * Build standalone executable with frontend assets embedded via Bun.
 *
 * Usage:
 *   bun scripts/build/exe-bundle.js --target windows [--require-webview]
 *   bun scripts/build/exe-bundle.js --target linux
 *   bun scripts/build/exe-bundle.js --target macos [--require-webview]
 *
 * `--arch` defaults to this machine's for linux and macos (so a macOS build on Apple
 * silicon is not an x64 binary under Rosetta), and to x64 for windows, the only one shipped.
 *
 * A macos or windows build embeds the native WebView library the desktop window loads
 * (`scripts/build/webview-native.ts`): built on the spot on a host of that OS, taken
 * prebuilt from `dist/native/<macos|windows>/` anywhere else. Missing, it is a warning — the
 * binary then opens Chrome/Edge like the linux target — unless `--require-webview` makes it
 * an error, which is how the release job stops a binary shipping without its window. On a
 * macOS host the build also wraps the binary in `dist/YAAR.app`, signed ad hoc.
 *
 * The three asset trees — the built frontend, the prebundled `@bundled/*` libraries, and
 * the onnxruntime-web artifacts — ride inside the binary via `bun build --compile --asset`,
 * which embeds a directory as-is (no HTML/CSS/JS parsing) and preserves each file's path
 * under the directory's own basename. At runtime they come back as `Bun.embeddedFiles`,
 * read by `packages/server/src/exe-assets.ts`.
 *
 * That basename is the contract, so this script does not pass the source directories
 * directly — `packages/frontend/dist` would embed everything under `dist/`. It builds a
 * small link farm under `dist/.exe-assets/` whose entries are named by
 * `EMBEDDED_ASSET_DIRS`, and passes those. Links, not copies: `--asset` follows a symlink
 * given to it directly (though not one it finds *inside* a directory it is walking, which
 * is why the ML artifacts are hard links).
 *
 * This replaced a generated entry point — a `_build-entry.generated.ts` holding one
 * `import … with { type: "file" }` per embedded file. The entry is now a checked-in file,
 * `packages/server/src/exe-bundle-entry.ts`.
 *
 * Provider is selected at runtime via config/settings.json or PROVIDER env var.
 */

import { execFileSync } from 'child_process';
import {
  readdirSync, readFileSync, existsSync,
  mkdirSync, rmSync, symlinkSync, linkSync, copyFileSync, cpSync, writeFileSync,
} from 'fs';
import { basename, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

import { BUNDLED_APPS_STAMP, EMBEDDED_ASSET_DIRS } from '../../packages/server/src/exe-assets.ts';
import { webviewLibraryPath } from './webview-native.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

// ── Parse CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const target = getArg('target') ?? 'linux';

const arch =
  getArg('arch') ?? (target !== 'windows' && process.arch === 'arm64' ? 'arm64' : 'x64');

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

// ── Locate the asset trees ───────────────────────────────────────────

/** Count files under `dir`, recursively — for the log lines, nothing else. */
function countFiles(dir, match = () => true) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name), match);
    else if (match(entry.name)) n++;
  }
  return n;
}

const frontendDist = join(rootDir, 'packages', 'frontend', 'dist');
if (!existsSync(frontendDist)) {
  console.error(`Frontend dist not found at ${frontendDist}`);
  console.error('Run "bun run build" first.');
  process.exit(1);
}
console.log(`Embedding ${countFiles(frontendDist)} frontend files into executable...`);

const bundledLibsDir = join(rootDir, 'dist', 'bundled-libs');
const hasBundledLibs = existsSync(bundledLibsDir);
if (hasBundledLibs) {
  const libCount = countFiles(bundledLibsDir, (n) => n.endsWith('.js'));
  console.log(`Embedding ${libCount} bundled libraries...`);
} else {
  console.warn('Warning: dist/bundled-libs/ not found. Run "bun run build:exe:libs" first.');
  console.warn('Bundled exe will not be able to resolve @bundled/* imports at runtime.');
}

// ── Collect onnxruntime-web runtime artifacts ────────────────────────
//
// The @bundled/yaar-ml SDK loads ORT from the server's /api/ml-runtime/ route. A
// standalone exe has no node_modules to serve that from, so the artifacts ride
// inside the binary like the frontend does. Only the files the shim actually
// pins are embedded — dist/ as a whole is 129MB of variants (jspi/webgl/node/all)
// nothing here loads.
//
// Keep this list in sync with packages/compiler/src/shims/yaar-ml.ts:
//   ORT_URL                  → ort.webgpu.bundle.min.mjs   (the module the app imports)
//   ORT_WASM_URL             → ort.wasm.bundle.min.mjs     (full-CPU flavor for wasm-only
//                              sessions — the asyncify build has fp64 compiled out)
//   ort.env.wasm.wasmPaths   → the .mjs glue + .wasm each bundle fetches at runtime
const ML_RUNTIME_ARTIFACTS = [
  'ort.webgpu.bundle.min.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort.wasm.bundle.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
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
  console.log(`Embedding ${mlRuntimeFiles.length} ML runtime artifacts (~38MB)...`);
} catch (err) {
  // Hard failure, not a warning. A binary without these silently 404s every
  // /api/ml-runtime/ request, and the only symptom is a blank window in whatever
  // app declared "bundles": ["yaar-ml"] — which is how this shipped unnoticed once.
  console.error(`Cannot locate the onnxruntime-web runtime artifacts: ${err.message}`);
  console.error('Run "bun install" first (onnxruntime-web is a dependency of @yaar/server).');
  process.exit(1);
}

// ── Stage the asset trees under the names they are embedded as ───────
//
// `--asset <path>` names its entries after `basename(path)`, so the staging names *are*
// the runtime prefixes. Symlinks for the two directories (followed when handed to
// `--asset` directly) and hard links for the ML artifacts, which have to sit *inside* a
// directory — `--asset` skips a symlink it encounters while walking one. Both are free;
// nothing here copies ~38MB of onnxruntime on every build.

const assetsDir = join(rootDir, 'dist', '.exe-assets');
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });

/** Link `target` into the staging dir under `name`, and return the path to pass to --asset. */
function stageDir(name, target) {
  const link = join(assetsDir, name);
  symlinkSync(target, link, 'dir');
  return link;
}

const assetPaths = [stageDir(EMBEDDED_ASSET_DIRS.frontend, frontendDist)];
if (hasBundledLibs) assetPaths.push(stageDir(EMBEDDED_ASSET_DIRS.bundledLibs, bundledLibsDir));

// ── Native WebView library (macOS, Windows) ────────────────────────

/** The exe target → the Node platform whose library it embeds. */
const WEBVIEW_PLATFORMS = { macos: 'darwin', windows: 'win32' };
const webviewPlatform = WEBVIEW_PLATFORMS[target];

let webviewLib = null;
if (webviewPlatform) {
  webviewLib = webviewLibraryPath(webviewPlatform);
  if (process.platform === webviewPlatform) {
    execFileSync('bun', [join(__dirname, 'webview-native.ts')], { cwd: rootDir, stdio: 'inherit' });
  }
  if (!existsSync(webviewLib)) {
    const msg = `WebView library not found at ${webviewLib} (build it on ${target}: bun scripts/build/webview-native.ts).`;
    if (args.includes('--require-webview')) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`Warning: ${msg}`);
    console.warn('This binary will open Chrome/Edge instead of its own window.');
    webviewLib = null;
  } else {
    console.log('Embedding the WebView library...');
  }
}

const mlStaging = join(assetsDir, EMBEDDED_ASSET_DIRS.mlRuntime);
mkdirSync(mlStaging, { recursive: true });
for (const { name, absPath } of mlRuntimeFiles) {
  const dest = join(mlStaging, name);
  // Hard link where possible; `dist/` and `node_modules/` are normally the same device,
  // but a bind-mounted or containerised checkout need not be.
  try {
    linkSync(absPath, dest);
  } catch {
    copyFileSync(absPath, dest);
  }
}
assetPaths.push(mlStaging);

if (webviewLib) {
  const nativeStaging = join(assetsDir, EMBEDDED_ASSET_DIRS.native);
  mkdirSync(nativeStaging, { recursive: true });
  copyFileSync(webviewLib, join(nativeStaging, basename(webviewLib)));
  assetPaths.push(nativeStaging);
}

// ── Build ────────────────────────────────────────────────────────────

const entrypoint = relative(
  rootDir,
  join(rootDir, 'packages', 'server', 'src', 'exe-bundle-entry.ts'),
);

// The binary has to carry its own version: PROJECT_ROOT for an exe is whatever
// directory the user dropped it in, so config/env.ts has no package.json to read
// there. Sourced from the same root package.json `scripts/release/set-version.ts` stamps,
// which is what release.yml asserts against the tag.
const pkgVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')).version;
const defines = [
  '--define', '__YAAR_BUNDLED=true',
  '--define', `__YAAR_VERSION=${JSON.stringify(pkgVersion)}`,
];

// argv, not a joined shell string: __YAAR_VERSION's value is a *JS string
// literal*, so the define carries quotes that sh and cmd.exe would each strip
// differently. Passing argv directly means no shell parses it at all — which
// also stops a path containing a space from silently splitting into two args.
const buildArgs = [
  'build',
  entrypoint,
  '--compile',
  `--target=${bunTarget}`,
  `--outfile=${relative(rootDir, outfile)}`,
  '--minify',
  // Bytecode moves parse+compile of the server bundle to build time. Cross-compiling it
  // needed Bun >= 1.4.1 (before that it broke to/from windows-x64 on macOS and Linux),
  // and this script cross-compiles all three shipped targets from one machine — hence
  // the `engines.bun` floor. The cache format is platform-independent as of the same
  // release, so two builds of one input are byte-identical whatever built them.
  '--bytecode',
  '--external', 'cpu-features',
  ...assetPaths.flatMap((p) => ['--asset', relative(rootDir, p)]),
  ...defines,
];

console.log(`Running: bun ${buildArgs.join(' ').slice(0, 140)}...`);

try {
  execFileSync('bun', buildArgs, { cwd: rootDir, stdio: 'inherit' });
  console.log(`\nBuilt: ${outfile}`);
} finally {
  // The link farm has served its purpose; leaving it would put a symlink to the frontend
  // build inside `dist/`, which the release step archives.
  rmSync(assetsDir, { recursive: true, force: true });
}

// ── macOS: wrap the binary in YAAR.app ───────────────────────────────
//
// The bundle is what lets the window record at all: WKWebView hides navigator.mediaDevices
// from every frame of a process whose main bundle has no NSMicrophoneUsageDescription, so
// a bare binary's window has no microphone API whatever the terminal was granted. The
// bundle is signed (ad hoc) because a grant is recorded against the signature.
//
// install.sh assembles the installed YAAR.app the same way on the user's Mac (the release
// is built on Linux, which has no codesign); macos-bundle-plist.test.ts keeps the two
// Info.plists identical.
//
// LSUIElement keeps the server process — the bundle's executable, which never opens a
// window — out of the Dock; the window process it spawns promotes itself to a regular app
// (packages/lib/src/webview/native/webview_extras.mm), so there is exactly one Dock icon.
//
// The bundle's data lives in ~/Library/Application Support/YAAR, not beside the binary
// (config/env.ts), and its apps ride read-only in Resources/ (macos-bundle.ts copies them
// out). macOS-host only: `codesign`, `sips` and `iconutil` are macOS tools.

if (target === 'macos' && process.platform === 'darwin') {
  const app = join(rootDir, 'dist', 'YAAR.app');
  const contents = join(app, 'Contents');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  copyFileSync(outfile, join(contents, 'MacOS', exeName));

  const appsDir = join(rootDir, 'apps');
  if (existsSync(appsDir)) {
    const shipped = join(contents, 'Resources', 'apps');
    cpSync(appsDir, shipped, { recursive: true });
    writeFileSync(join(shipped, BUNDLED_APPS_STAMP), `${pkgVersion} ${new Date().toISOString()}\n`);
  }

  const iconPng = join(rootDir, 'packages', 'frontend', 'public', 'icon-512.png');
  let iconKeys = '';
  if (existsSync(iconPng)) {
    const iconset = join(rootDir, 'dist', '.YAAR.iconset');
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, px] of [['', size], ['@2x', size * 2]]) {
        if (px > 512) continue;
        execFileSync('sips', ['-z', String(px), String(px), iconPng, '--out',
          join(iconset, `icon_${size}x${size}${scale}.png`)], { stdio: 'ignore' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources', 'YAAR.icns')]);
    rmSync(iconset, { recursive: true, force: true });
    iconKeys = '  <key>CFBundleIconFile</key><string>YAAR</string>\n';
  }

  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>YAAR</string>
  <key>CFBundleDisplayName</key><string>YAAR</string>
  <key>CFBundleIdentifier</key><string>io.github.sorryhyun.yaar</string>
  <key>CFBundleExecutable</key><string>${exeName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkgVersion}</string>
  <key>CFBundleVersion</key><string>${pkgVersion}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>YAAR apps record audio when you ask them to, for example to transcribe speech.</string>
${iconKeys}</dict>
</plist>
`);

  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`Built: ${app}`);
}
