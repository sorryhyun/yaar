#!/usr/bin/env bun
/**
 * Sync app sources into a local checkout of the marketplace repo, so a batch of
 * apps can be published with one `git push` instead of one UI publish each.
 *
 * The file set is the same one `features/apps/publish.ts` tars: the app
 * directory minus `dist/` (the marketplace ships source and YAAR compiles on
 * install), minus `.DS_Store` and `._*`. The marketplace commits a *replacement*
 * of `apps/{id}` rather than an overlay, so this mirrors — a file deleted
 * locally is deleted there too.
 *
 * Two guards this path does not get for free, because a direct push skips the
 * server that normally enforces them:
 *   - the publish endpoint refuses a version that is not newer than what is
 *     live, so `--bump` (on by default) keeps that invariant holding;
 *   - `app.json` fields edited on the marketplace side would be silently
 *     reverted by a blind copy, so fields named in `--keep-market` are read back
 *     from the marketplace copy and reported.
 *
 * Usage:
 *   bun scripts/release/sync-market.ts <appId...> [options]
 *   bun scripts/release/sync-market.ts --all
 *
 *   --all                  every app id present in both the local roots and the marketplace
 *   --skip <id,...>        app ids to leave alone (note: `memo` resolves to the bundled
 *                          app, which is a different app from the published `memo`)
 *   --market <path>        marketplace checkout (default: ../yaarmarket)
 *   --keep-market <f,...>  app.json fields the marketplace owns (default: description)
 *   --no-bump              leave versions alone instead of bumping the patch
 *   --no-commit            stage nothing; just write the files
 *   --dry-run              report what would change and touch nothing
 */
import { chmod, mkdir, readdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '../..');
// Bundled first, matching resolveAppDir()'s precedence in features/apps/roots.ts.
const APP_ROOTS = [join(PROJECT_ROOT, 'apps'), join(PROJECT_ROOT, 'user-apps')];

const APP_ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_FILES = 500;
const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const MARKET = resolve(PROJECT_ROOT, value('--market', '../yaarmarket'));
const KEEP_MARKET = value('--keep-market', 'description')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP = value('--skip', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BUMP = !flag('--no-bump');
const COMMIT = !flag('--no-commit');
const DRY = flag('--dry-run');

const TAKES_VALUE = ['--market', '--keep-market', '--skip'];
const ids = argv.filter((a, i) => !a.startsWith('--') && !TAKES_VALUE.includes(argv[i - 1] ?? ''));

/** The app directory for an id, bundled root winning on collision. */
function resolveAppDir(id: string): string | null {
  for (const root of APP_ROOTS) {
    const dir = join(root, id);
    if (existsSync(join(dir, 'app.json'))) return dir;
  }
  return null;
}

const skipped = (rel: string) =>
  rel === 'dist' ||
  rel.startsWith('dist/') ||
  basename(rel) === '.DS_Store' ||
  basename(rel).startsWith('._');

/** Every publishable file under an app dir, as paths relative to it. */
async function collect(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipped(rel)) continue;
    if (entry.isDirectory()) out.push(...(await collect(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const parseVersion = (v: unknown) => {
  const m = typeof v === 'string' ? v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/) : null;
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], suffix: m[4] } : null;
};
const cmpVersion = (a: NonNullable<ReturnType<typeof parseVersion>>, b: typeof a) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

type Result = {
  id: string;
  written: number;
  deleted: number;
  unchanged?: boolean;
  version?: string;
  notes: string[];
};

/**
 * Whether the marketplace copy already matches the local app. `version` is
 * excluded from the app.json comparison because it is this script's own output,
 * not an input — comparing it would make every app look changed.
 */
async function differs(
  srcDir: string,
  destDir: string,
  files: string[],
  existing: string[],
  meta: Record<string, unknown>,
  marketMeta: Record<string, unknown>,
): Promise<boolean> {
  if (!existsSync(destDir)) return true;
  if (files.length !== existing.length) return true;
  if (files.some((rel) => !existing.includes(rel))) return true;

  const canonical = (o: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => k !== 'version')
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  if (canonical(meta) !== canonical(marketMeta)) return true;

  for (const rel of files) {
    if (rel === 'app.json') continue;
    const a = await readFile(join(srcDir, rel));
    const b = await readFile(join(destDir, rel));
    if (!a.equals(b)) return true;
  }
  return false;
}

async function syncApp(id: string): Promise<Result | null> {
  const notes: string[] = [];
  if (!APP_ID_RE.test(id)) {
    console.error(`  ✗ ${id}: id must match ${APP_ID_RE} — the marketplace rejects it`);
    return null;
  }
  const srcDir = resolveAppDir(id);
  if (!srcDir) {
    console.error(`  ✗ ${id}: no app.json under apps/ or user-apps/`);
    return null;
  }

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await readFile(join(srcDir, 'app.json'), 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${id}: app.json is not valid JSON — ${(e as Error).message}`);
    return null;
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    console.error(`  ✗ ${id}: app.json must be a JSON object`);
    return null;
  }
  if (meta.appId !== undefined && meta.appId !== id) {
    console.error(`  ✗ ${id}: app.json declares appId "${meta.appId}"`);
    return null;
  }

  const files = await collect(srcDir);
  let bytes = 0;
  for (const rel of files) bytes += (await stat(join(srcDir, rel))).size;
  if (files.length > MAX_FILES) {
    console.error(`  ✗ ${id}: ${files.length} files exceeds the marketplace cap of ${MAX_FILES}`);
    return null;
  }
  if (bytes > MAX_UNPACKED_BYTES) {
    console.error(
      `  ✗ ${id}: ${(bytes / 1e6).toFixed(1)}MB exceeds the ${MAX_UNPACKED_BYTES / 1e6}MB cap`,
    );
    return null;
  }

  const destDir = join(MARKET, 'apps', id);
  const existing = existsSync(destDir) ? await collect(destDir) : [];

  // app.json is rewritten rather than copied: the marketplace owns some fields,
  // and the version has to outrank what is already published.
  const marketMetaPath = join(destDir, 'app.json');
  let marketMeta: Record<string, unknown> = {};
  if (existsSync(marketMetaPath)) {
    try {
      marketMeta = JSON.parse(await readFile(marketMetaPath, 'utf8'));
    } catch {
      notes.push('marketplace app.json was unreadable — local wins for every field');
    }
  }
  for (const field of KEEP_MARKET) {
    if (
      marketMeta[field] !== undefined &&
      JSON.stringify(marketMeta[field]) !== JSON.stringify(meta[field])
    ) {
      meta[field] = marketMeta[field];
      notes.push(`kept marketplace ${field}`);
    }
  }

  // Bumping unconditionally would inflate the version every run, so an app whose
  // content already matches is left alone entirely — that keeps `--all` safe to
  // re-run and keeps a version bump meaning "something actually changed".
  if (!(await differs(srcDir, destDir, files, existing, meta, marketMeta))) {
    return { id, written: 0, deleted: 0, unchanged: true, version: meta.version as string, notes };
  }

  if (BUMP) {
    const local = parseVersion(meta.version);
    const market = parseVersion(marketMeta.version);
    if (!local) {
      notes.push(`version ${JSON.stringify(meta.version)} is not semver — left alone`);
    } else {
      const base = market && cmpVersion(market, local) > 0 ? market : local;
      meta.version = `${base.major}.${base.minor}.${base.patch + 1}${base.suffix}`;
      notes.push(
        `version ${local.major}.${local.minor}.${local.patch}${local.suffix} → ${meta.version}`,
      );
    }
  }

  const stale = existing.filter((rel) => !files.includes(rel));
  if (DRY)
    return {
      id,
      written: files.length,
      deleted: stale.length,
      version: meta.version as string,
      notes,
    };

  for (const rel of stale) await rm(join(destDir, rel));
  for (const rel of files) {
    if (rel === 'app.json') continue;
    const to = join(destDir, rel);
    await mkdir(dirname(to), { recursive: true });
    // Not copyFile: that carries the source's mode across, and app sources on
    // disk are often 0755. The publish endpoint writes every blob as 100644,
    // so copying the bit would show up as a mode change on every file.
    await writeFile(to, await readFile(join(srcDir, rel)), { mode: 0o644 });
    await chmod(to, 0o644);
  }
  await mkdir(destDir, { recursive: true });
  await writeFile(marketMetaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 });
  await chmod(marketMetaPath, 0o644);

  return {
    id,
    written: files.length,
    deleted: stale.length,
    version: meta.version as string,
    notes,
  };
}

if (!existsSync(join(MARKET, 'apps'))) {
  console.error(`No marketplace checkout at ${MARKET} (expected an apps/ directory).`);
  process.exit(1);
}

let targets = ids;
if (flag('--all')) {
  const published = await readdir(join(MARKET, 'apps'));
  targets = published.filter((id) => resolveAppDir(id));
  const orphans = published.filter((id) => !resolveAppDir(id));
  if (orphans.length)
    console.log(`Published with no local source, left untouched: ${orphans.join(', ')}\n`);
}
if (SKIP.length) {
  const hit = targets.filter((id) => SKIP.includes(id));
  targets = targets.filter((id) => !SKIP.includes(id));
  if (hit.length) console.log(`Skipped by request: ${hit.join(', ')}\n`);
}
if (!targets.length) {
  console.error('Usage: bun scripts/release/sync-market.ts <appId...> | --all');
  process.exit(1);
}

console.log(`${DRY ? 'Would sync' : 'Syncing'} ${targets.length} app(s) → ${MARKET}\n`);
const results: Result[] = [];
for (const id of targets) {
  const r = await syncApp(id);
  if (!r) continue;
  results.push(r);
  if (r.unchanged) {
    console.log(`  · ${id.padEnd(24)} unchanged`);
    continue;
  }
  const bits = [`${r.written} file(s)`];
  if (r.deleted) bits.push(`${r.deleted} removed`);
  console.log(`  ✓ ${id.padEnd(24)} ${bits.join(', ')}`);
  for (const n of r.notes) console.log(`      ${n}`);
}
const changed = results.filter((r) => !r.unchanged);

if (results.length !== targets.length) {
  console.error(
    `\n${targets.length - results.length} app(s) failed validation — nothing was committed.`,
  );
  process.exit(1);
}

if (DRY) {
  console.log('\nDry run — nothing written.');
} else if (COMMIT) {
  const { $ } = await import('bun');
  await $`git -C ${MARKET} add apps`.quiet();
  const staged = (await $`git -C ${MARKET} diff --cached --name-only`.text()).trim();
  if (!staged) {
    console.log('\nNothing changed — no commit made.');
  } else {
    const list = changed.map((r) => `- ${r.id} ${r.version ?? ''}`.trimEnd()).join('\n');
    const message = `Publish ${changed.length} app(s) from yaar\n\n${list}\n`;
    await $`git -C ${MARKET} commit -q -m ${message}`;
    console.log(`\nCommitted in ${MARKET}:`);
    console.log(await $`git -C ${MARKET} log --oneline -1`.text());
    console.log('Review, then push:  git -C ../yaarmarket push');
  }
}
