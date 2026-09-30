#!/usr/bin/env bun
/**
 * Build the native WebView library the desktop window loads through `bun:ffi`.
 *
 * Usage:
 *   bun scripts/build/webview-native.ts            # the host platform
 *   bun scripts/build/webview-native.ts --check    # exit 0 if this host can build it, else 1
 *
 * Output: `dist/native/<platform>/<library>` — the path `exe-bundle.js` embeds from and a
 * source checkout loads from (`packages/server/src/desktop-window/library.ts`).
 *
 * Sources are `packages/lib/src/webview/native/`, beside the FFI binding that loads them: the
 * vendored `webview/webview.h` (never edited) and YAAR's additions to it, one file per
 * platform with the same C API — `webview_extras.mm` (Cocoa) and `webview_extras_win.cc`
 * (Win32 + WebView2).
 *
 *  - **macOS**: a universal (arm64 + x86_64) dylib, so one build serves both macOS release
 *    binaries. Only macOS can build it (it links the system WebKit and Cocoa frameworks).
 *  - **Windows**: an x64 DLL (the only Windows binary shipped), built with MSVC found through
 *    `vswhere`, the C runtime linked statically so it needs nothing beyond the OS and the
 *    WebView2 runtime. `webview.h` needs Microsoft's `WebView2.h`, which is not vendored
 *    (2.9 MB, generated): it comes from the pinned NuGet package below, checked against its
 *    hash and cached under `dist/native/.cache/`. So does the loader: Microsoft's, linked
 *    statically (`WebView2LoaderStatic.lib`), not webview.h's built-in one — only the
 *    official loader reads `WEBVIEW2_USER_DATA_FOLDER` and
 *    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, the only way to set a profile folder or a
 *    CDP port with webview.h unedited (it passes neither). Still one DLL, nothing beside it.
 *
 * Linux (WebKitGTK) is a later phase of `docs/proposals/webview_host_proposal.md`; there
 * this script says so and exits non-zero, and the exe opens Chrome/Edge as before. The
 * release workflow builds each library on its own OS and hands the files to the Linux job
 * that cross-compiles the binaries.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

const rootDir = join(import.meta.dir, '..', '..');
const nativeDir = join(rootDir, 'packages', 'lib', 'src', 'webview', 'native');

/** `dist/native/<dir>/<file>` per platform — shared with exe-bundle.js. */
export const WEBVIEW_LIBRARIES = {
  darwin: { dir: 'macos', file: 'libwebview.dylib' },
  win32: { dir: 'windows', file: 'webview.dll' },
} as const;

export function webviewLibraryPath(platform: NodeJS.Platform = process.platform): string | null {
  const lib = WEBVIEW_LIBRARIES[platform as keyof typeof WEBVIEW_LIBRARIES];
  return lib ? join(rootDir, 'dist', 'native', lib.dir, lib.file) : null;
}

function buildMacos(out: string): void {
  mkdirSync(dirname(out), { recursive: true });
  const args = [
    '-dynamiclib',
    '-std=c++17',
    '-O2',
    '-DWEBVIEW_BUILD_SHARED',
    '-I',
    nativeDir,
    // Both slices in one file: the release ships macos-x64 and macos-arm64 binaries and
    // embeds the same library in each.
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    // Bun's own floor for its macOS builds; nothing here needs newer.
    '-mmacosx-version-min=13.0',
    '-fobjc-arc',
    // Upstream's `operator"" _sel` spelling, which newer clang deprecates. The header is
    // vendored unedited, so the warning is silenced rather than fixed (older clang does
    // not know the flag, hence the second one).
    '-Wno-deprecated-literal-operator',
    '-Wno-unknown-warning-option',
    join(nativeDir, 'webview.cc'),
    join(nativeDir, 'webview_extras.mm'),
    '-framework',
    'WebKit',
    '-framework',
    'Cocoa',
    // webview_extras.mm: capture permission (AVCaptureDevice) and the loopback TLS pin.
    '-framework',
    'AVFoundation',
    '-framework',
    'Security',
    '-install_name',
    '@rpath/libwebview.dylib',
    '-o',
    out,
  ];
  execFileSync('clang++', args, { stdio: 'inherit' });
}

// ── Windows ────────────────────────────────────────────────────────────

/**
 * The WebView2 SDK whose `WebView2.h` the DLL compiles against. Any version at least as
 * new as the interfaces `webview_extras_win.cc` uses (ICoreWebView2_14) works; bumping it
 * is a new version and hash here, nothing else. The runtime on the user's machine is
 * Evergreen and independent of this.
 */
const WEBVIEW2_SDK = {
  version: '1.0.4258.31',
  sha256: '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9',
};

/**
 * The SDK's header and x64 static-loader directories, downloading and unpacking the pinned
 * package on first use.
 */
async function webview2Sdk(): Promise<{ include: string; lib: string }> {
  const { version, sha256 } = WEBVIEW2_SDK;
  const cache = join(rootDir, 'dist', 'native', '.cache', `webview2-${version}`);
  const sdk = {
    include: join(cache, 'build', 'native', 'include'),
    lib: join(cache, 'build', 'native', 'x64'),
  };
  if (
    existsSync(join(sdk.include, 'WebView2.h')) &&
    existsSync(join(sdk.lib, 'WebView2LoaderStatic.lib'))
  ) {
    return sdk;
  }

  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`;
  console.log(`Fetching the WebView2 SDK ${version}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);

  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const pkg = join(cache, 'webview2.nupkg');
  writeFileSync(pkg, bytes);
  // A .nupkg is a zip. Windows' own tar (bsdtar) reads zips; Git Bash's GNU tar, which
  // may come first on PATH, does not — hence the absolute path.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(
    tar,
    ['-xf', pkg, '-C', cache, 'build/native/include', 'build/native/x64/WebView2LoaderStatic.lib'],
    { stdio: 'inherit' },
  );
  rmSync(pkg);
  return sdk;
}

/** vcvars64.bat of the newest Visual Studio (or Build Tools) with the x64 C++ tools, or null. */
function findVcvars(): string | null {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return null;
  const install = execFileSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  ).trim();
  const vcvars = install && join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return vcvars && existsSync(vcvars) ? vcvars : null;
}

async function buildWindows(out: string): Promise<void> {
  if (process.arch !== 'x64') {
    // vcvars64 makes x64 code, which an arm64 Bun cannot load; the release ships x64 only.
    throw new Error(`the Windows library is x64 only; this Bun is ${process.arch}`);
  }
  const vcvars = findVcvars();
  if (!vcvars) {
    throw new Error(
      'no MSVC found: install Visual Studio Build Tools with "Desktop development with C++"',
    );
  }
  const sdk = await webview2Sdk();
  const obj = join(rootDir, 'dist', 'native', '.cache', 'obj-windows');
  mkdirSync(obj, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  const q = (s: string) => `"${s}"`;
  const cl = [
    'cl',
    '/nologo',
    '/LD',
    '/EHsc',
    '/std:c++17',
    '/O2',
    // Static C runtime: no vcruntime140.dll/msvcp140.dll to find on the user's machine.
    '/MT',
    '/utf-8',
    '/DWEBVIEW_BUILD_SHARED',
    // Microsoft's loader, statically linked, instead of webview.h's built-in one (see top).
    '/DWEBVIEW_MSWEBVIEW2_BUILTIN_IMPL=0',
    '/DWEBVIEW_MSWEBVIEW2_EXPLICIT_LINK=0',
    '/I',
    q(nativeDir),
    '/I',
    q(sdk.include),
    q(join(nativeDir, 'webview.cc')),
    q(join(nativeDir, 'webview_extras_win.cc')),
    `/Fe:${q(out)}`,
    // Objects into the working directory (`obj`): a quoted directory ending in `\"` would
    // escape its own closing quote.
    '/Fo:.\\',
    '/link',
    `/IMPLIB:${q(join(obj, 'webview.lib'))}`,
    q(join(sdk.lib, 'WebView2LoaderStatic.lib')),
    // webview.h: COM, the window, DPI, the runtime's version resource.
    'advapi32.lib',
    'ole32.lib',
    'shell32.lib',
    'shlwapi.lib',
    'user32.lib',
    'version.lib',
    // webview_extras_win.cc: the window subclass, URL parsing, the TLS pin.
    'comctl32.lib',
    'oleaut32.lib',
    'urlmon.lib',
    'crypt32.lib',
    'bcrypt.lib',
  ].join(' ');
  // vcvars64 only sets up the environment of the cmd.exe it runs in, so the compile runs
  // in that same cmd, from a script file (cmd's own quoting of a /c string is unreliable).
  const script = join(obj, 'build.cmd');
  writeFileSync(script, `@echo off\r\ncall ${q(vcvars)} >nul || exit /b 1\r\n${cl}\r\n`);
  execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit', cwd: obj });
}

if (import.meta.main) {
  const out = webviewLibraryPath();
  if (process.argv.includes('--check')) process.exit(out ? 0 : 1);
  if (!out) {
    console.error(
      `No WebView host for ${process.platform} yet — the exe keeps opening Chrome/Edge there.`,
    );
    process.exit(1);
  }
  if (process.platform === 'win32') await buildWindows(out);
  else buildMacos(out);
  console.log(`Built ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
}
