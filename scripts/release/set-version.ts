/**
 * Set the project version across all files that carry a version literal.
 *
 * Usage: bun scripts/release/set-version.ts <version>   (leading "v" is stripped)
 *
 * Updates:
 *   - root package.json + every packages/ * /package.json that has a version
 *   - README.md / README.ko.md  (VERSION=vX.Y.Z install example)
 * The OpenAPI spec derives its version from root package.json, so run
 * `bun run generate:openapi` afterwards to refresh docs/reference/openapi.yaml.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: bun scripts/release/set-version.ts <version>');
  process.exit(1);
}

const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: "${raw}" (expected semver like 0.12.0 or v0.12.0)`);
  process.exit(1);
}

const root = join(import.meta.dir, '..', '..');

/** Replace only the first `"version": "..."` line, preserving all other formatting. */
function bumpPackageJson(path: string): boolean {
  const before = readFileSync(path, 'utf-8');
  if (!/"version":\s*"[^"]*"/.test(before)) return false; // no version field (e.g. tests package)
  const after = before.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  if (after !== before) writeFileSync(path, after, 'utf-8');
  return after !== before;
}

const pkgFiles = [
  join(root, 'package.json'),
  ...readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, 'packages', d.name, 'package.json')),
];

for (const f of pkgFiles) {
  try {
    if (bumpPackageJson(f)) console.log(`  updated ${f.replace(root + '/', '')}`);
  } catch {
    /* package.json may not exist for every dir; ignore */
  }
}

// README install example: VERSION=v<old> -> VERSION=v<new>
for (const readme of ['README.md', 'README.ko.md']) {
  const path = join(root, readme);
  try {
    const before = readFileSync(path, 'utf-8');
    const after = before.replace(/VERSION=v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/g, `VERSION=v${version}`);
    if (after !== before) {
      writeFileSync(path, after, 'utf-8');
      console.log(`  updated ${readme}`);
    }
  } catch {
    /* readme optional */
  }
}

console.log(`Version set to ${version}`);
