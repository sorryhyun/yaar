#!/usr/bin/env bun
/**
 * Cross-platform Codex type generation script.
 *
 * Usage: bun scripts/generate-codex-types.js [codex-binary]
 *
 * 1. Removes packages/server/src/providers/codex/generated/
 * 2. Runs `<codex-bin> app-server generate-ts`
 * 3. Post-processes imports to add .js extensions (required by ESM)
 * 4. Fixes the ./v2 directory import to ./v2/index.js
 */

import { execFileSync } from 'child_process';
import { rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'packages', 'server', 'src', 'providers', 'codex', 'generated');
const codexBin = process.argv[2] || 'codex';

// 1. Remove existing generated directory
console.log('Removing', outDir);
rmSync(outDir, { recursive: true, force: true });

// 2. Run codex app-server generate-ts
console.log(`Running: ${codexBin} app-server generate-ts`);
execFileSync(codexBin, [
  'app-server', 'generate-ts',
  '--out', outDir,
  '--experimental',
], { stdio: 'inherit', cwd: rootDir });

// 3. Post-process: add .js extensions to relative imports
function processDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      let content = readFileSync(fullPath, 'utf8');
      // Add .js to relative imports: from "./foo" or from "../foo" → with .js
      const updated = content.replace(/from "(\.[^"]+)"/g, (match, p1) => {
        if (p1.endsWith('.js')) return match;
        return `from "${p1}.js"`;
      });
      // Fix directory import: from "./v2.js" → from "./v2/index.js"
      const fixed = updated.replace(/from "\.\/v2\.js"/g, 'from "./v2/index.js"');
      if (fixed !== content) {
        writeFileSync(fullPath, fixed, 'utf8');
      }
    }
  }
}

console.log('Adding .js extensions to generated imports...');
processDir(outDir);
console.log('Done.');
