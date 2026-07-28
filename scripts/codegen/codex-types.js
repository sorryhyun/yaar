#!/usr/bin/env bun
/**
 * Cross-platform Codex type generation script.
 *
 * Usage: bun scripts/codegen/codex-types.js [codex-binary] [--force]
 *
 * 0. Refuses to run against a CLI older than CODEX_MIN_VERSION (--force overrides)
 * 1. Removes packages/server/src/providers/codex/generated/
 * 2. Runs `<codex-bin> app-server generate-ts`
 * 3. Post-processes imports to add .js extensions (required by ESM)
 * 4. Fixes the ./v2 directory import to ./v2/index.js
 * 5. Stamps generated/codex-version.ts with the version it generated from
 *
 * Step 0 exists because generating from an under-versioned CLI is the one mistake that
 * produces no error at all: the bindings compile fine and describe a protocol the shipped
 * binary no longer speaks. Step 5 makes the provenance machine-readable so the runtime
 * checks and `codex-version.test.ts` can reason about it instead of trusting a commit
 * message.
 */

import { execFileSync } from 'child_process';
import { rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CODEX_MIN_VERSION,
  CODEX_UPGRADE_HINT,
  isAtLeast,
  parseVersionOutput,
} from '../../packages/server/src/providers/codex/version.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const outDir = join(rootDir, 'packages', 'server', 'src', 'providers', 'codex', 'generated');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const codexBin = argv.find((a) => !a.startsWith('--')) || 'codex';

// 0. Version gate. Fails closed — including on output we cannot parse — because this runs
//    on a developer machine where a loud stop is cheap and silently-wrong bindings are not.
let rawVersion;
try {
  rawVersion = execFileSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
} catch (err) {
  console.error(`Could not run \`${codexBin} --version\`: ${err.message}`);
  console.error(`Install it with: ${CODEX_UPGRADE_HINT}`);
  process.exit(1);
}

const version = parseVersionOutput(rawVersion);
const satisfies = version ? isAtLeast(version, CODEX_MIN_VERSION) : null;

if (satisfies !== true && !force) {
  const found = version
    ? `found ${version}`
    : `could not parse a version from: ${rawVersion.trim()}`;
  console.error(
    `Refusing to generate: YAAR requires codex >= ${CODEX_MIN_VERSION}, ${found}.\n` +
      `Upgrade with: ${CODEX_UPGRADE_HINT}\n` +
      `Or re-run with --force to generate anyway (then raise CODEX_MIN_VERSION to match).`,
  );
  process.exit(1);
}
if (satisfies !== true) {
  console.warn(`--force: generating from an unverified codex (${version ?? 'unknown version'})`);
}
console.log(`Generating from codex ${version ?? 'unknown'} (minimum ${CODEX_MIN_VERSION})`);

// 1. Remove existing generated directory
console.log('Removing', outDir);
rmSync(outDir, { recursive: true, force: true });

// 2. Run codex app-server generate-ts
console.log(`Running: ${codexBin} app-server generate-ts`);
execFileSync(codexBin, ['app-server', 'generate-ts', '--out', outDir, '--experimental'], {
  stdio: 'inherit',
  cwd: rootDir,
});

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

// 5. Stamp the provenance. Lives inside generated/ so it shares that directory's lifecycle:
//    anyone who runs `generate-ts` by hand wipes the stamp too, and the typecheck fails
//    rather than leaving a stale claim behind.
const stampPath = join(outDir, 'codex-version.ts');
writeFileSync(
  stampPath,
  `// GENERATED CODE! DO NOT MODIFY BY HAND!\n` +
    `// Written by scripts/codegen/codex-types.js — re-run \`make codex-types\` to update.\n\n` +
    `/** The \`codex\` CLI version these bindings were generated from. */\n` +
    `export const CODEX_GENERATED_FROM = ${JSON.stringify(version ?? 'unknown')};\n`,
  'utf8',
);
console.log(`Stamped ${stampPath} with ${version ?? 'unknown'}`);
console.log('Done.');
