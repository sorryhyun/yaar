#!/usr/bin/env bun
/**
 * Copy assets for standalone .exe distribution.
 *
 * Copies:
 * - Frontend dist to dist/public/
 * - Poppler binaries to dist/poppler/ (Windows only)
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
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
// Find the bin/ directory containing pdftocairo.exe etc.
function findPopplerBin(baseDir) {
  // Walk into node-poppler-win32 looking for a bin/ dir with pdftocairo.exe
  const candidates = [
    // Hoisted
    join(baseDir, 'node_modules', 'node-poppler-win32'),
    join(baseDir, 'node_modules', '@nicecatchltd', 'node-poppler-win32'),
  ];

  // Also search pnpm store
  const pnpmBase = join(baseDir, 'node_modules', '.pnpm');
  if (existsSync(pnpmBase)) {
    try {
      const entries = readdirSync(pnpmBase);
      for (const entry of entries) {
        if (entry.startsWith('node-poppler-win32@')) {
          candidates.push(join(pnpmBase, entry, 'node_modules', 'node-poppler-win32'));
        }
      }
    } catch { /* ignore */ }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // Recursively find the bin/ directory containing pdftocairo.exe
    const binDir = findBinDir(candidate);
    if (binDir) return binDir;
  }
  return null;
}

function findBinDir(dir) {
  if (existsSync(join(dir, 'pdftocairo.exe'))) return dir;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const result = findBinDir(join(dir, entry.name));
        if (result) return result;
      }
    }
  } catch { /* ignore */ }
  return null;
}

const popplerBinDir = findPopplerBin(rootDir);
const popplerDir = join(distDir, 'poppler');
let popplerCopied = false;

if (popplerBinDir) {
  console.log(`Copying poppler binaries from ${popplerBinDir} to dist/poppler/...`);
  cpSync(popplerBinDir, popplerDir, { recursive: true });
  console.log('  Done.');
  popplerCopied = true;
} else {
  console.warn('Warning: Poppler binaries not found.');
  console.warn('  Install node-poppler-win32:');
  console.warn('    pnpm add -D node-poppler-win32');
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
