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
 * vendored `webview/webview.h` (never edited) and `webview_extras.mm`, YAAR's additions.
 * macOS only for now — a universal (arm64 + x86_64) dylib, so one build serves both macOS
 * release binaries. Windows (WebView2) and Linux
 * (WebKitGTK) are later phases of `docs/proposals/webview_host_proposal.md`, and on those
 * hosts this script says so and exits non-zero; the exe then opens Chrome/Edge as before.
 *
 * Only macOS can build the macOS library (it links the system WebKit and Cocoa
 * frameworks), which is why the release workflow builds it on a macOS runner and hands the
 * file to the Linux job that cross-compiles the binaries.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

const rootDir = join(import.meta.dir, '..', '..');
const nativeDir = join(rootDir, 'packages', 'lib', 'src', 'webview', 'native');

/** `dist/native/<dir>/<file>` per platform — shared with exe-bundle.js. */
export const WEBVIEW_LIBRARIES = {
  darwin: { dir: 'macos', file: 'libwebview.dylib' },
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

if (import.meta.main) {
  const out = webviewLibraryPath();
  if (process.argv.includes('--check')) process.exit(out ? 0 : 1);
  if (!out) {
    console.error(
      `No WebView host for ${process.platform} yet — the exe keeps opening Chrome/Edge there.`,
    );
    process.exit(1);
  }
  buildMacos(out);
  console.log(`Built ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
}
