/**
 * Fail if any package.json pins a dependency version outside the root catalog.
 *
 * Every version range in this repo is written once, in `workspaces.catalog` of
 * the root package.json. A workspace names a dependency and says `catalog:`;
 * the range itself lives in exactly one file, so `three` cannot be `^0.183.2`
 * in one package and `^0.182.0` in another — which is precisely how
 * `@types/three` came to trail `three` by a minor for several releases, a drift
 * no install, typecheck, or test ever complained about.
 *
 * The rule is mechanical, which is why it is checked rather than documented:
 * outside the catalog, a dependency value may only be `catalog:` or
 * `workspace:*`. An exact literal is not an exception to be argued for — it is
 * a second place to look, and the point of the catalog is that there is one.
 *
 * Also reported: catalog entries nothing depends on. Those are not failures —
 * a catalogued range with no consumer is dead weight rather than a hazard, and
 * `bun install` keeps ignoring it — but they are worth seeing, because a
 * catalog that accumulates them stops being a reliable index of what is in the
 * tree.
 *
 * Usage:
 *   bun run scripts/check/deps.ts
 *
 * Exit code: 1 if any workspace pins a literal version.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

type PackageJson = {
  workspaces?: { catalog?: Record<string, string> };
} & Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;

const read = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf-8'));

const rootPath = join(ROOT, 'package.json');
const catalog = read(rootPath).workspaces?.catalog ?? {};

const packagePaths = [
  rootPath,
  ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ROOT, 'packages', d.name, 'package.json'))
    .filter((p) => Bun.file(p).size > 0),
];

const violations: string[] = [];
const used = new Set<string>();

for (const path of packagePaths) {
  const pkg = read(path);
  const where = relative(ROOT, path);
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (range.startsWith('workspace:')) continue;
      if (range === 'catalog:') {
        used.add(name);
        if (!(name in catalog)) {
          violations.push(`${where} ${field}.${name} says "catalog:" but the catalog has no entry`);
        }
        continue;
      }
      violations.push(
        `${where} ${field}.${name} pins "${range}" — move the range to the root catalog and say "catalog:" here`,
      );
    }
  }
}

const orphans = Object.keys(catalog).filter((name) => !used.has(name));
if (orphans.length > 0) {
  console.log(`Catalog entries nothing depends on (${orphans.length}): ${orphans.join(', ')}`);
}

if (violations.length > 0) {
  console.error(`\n${violations.length} dependency version(s) defined outside the catalog:\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`All dependencies across ${packagePaths.length} package.json files use the catalog.`);
