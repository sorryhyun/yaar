#!/usr/bin/env node
/**
 * Copy assets for standalone .exe distribution.
 *
 * Copies:
 * - Frontend dist to dist/public/
 * - Poppler binaries to dist/poppler/ (Windows only)
 */

import { cpSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Copy frontend dist to dist/public/
const frontendDist = join(rootDir, 'packages', 'frontend', 'dist');
const publicDir = join(distDir, 'public');

if (existsSync(frontendDist)) {
  console.log('Copying frontend assets to dist/public/...');
  cpSync(frontendDist, publicDir, { recursive: true });
  console.log('  Done.');
} else {
  console.warn('Warning: Frontend dist not found at', frontendDist);
  console.warn('  Run "pnpm --filter @claudeos/frontend build" first.');
}

// Copy poppler binaries (Windows)
const popplerSources = [
  join(rootDir, 'node_modules', 'node-poppler-win32', 'lib'),
  join(rootDir, 'node_modules', '@nicecatchltd', 'node-poppler-win32', 'lib'),
];

const popplerDir = join(distDir, 'poppler');

let popplerCopied = false;
for (const popplerSrc of popplerSources) {
  if (existsSync(popplerSrc)) {
    console.log('Copying poppler binaries to dist/poppler/...');
    cpSync(popplerSrc, popplerDir, { recursive: true });
    console.log('  Done.');
    popplerCopied = true;
    break;
  }
}

if (!popplerCopied) {
  console.warn('Warning: Poppler binaries not found.');
  console.warn('  On Windows, install node-poppler-win32:');
  console.warn('    pnpm add -D node-poppler-win32');
  console.warn('  On Linux/macOS, poppler-utils must be installed system-wide:');
  console.warn('    brew install poppler  # macOS');
  console.warn('    apt install poppler-utils  # Ubuntu/Debian');
}

console.log('\nAsset copy complete!');
console.log('Distribution structure:');
console.log('  dist/');
console.log('  ├── yaar-claude.exe   # Claude provider executable');
console.log('  ├── yaar-codex.exe    # Codex provider executable');
console.log('  ├── public/           # Frontend assets');
if (popplerCopied) {
  console.log('  ├── poppler/          # Poppler PDF binaries');
}
console.log('  └── storage/          # Created at runtime');
