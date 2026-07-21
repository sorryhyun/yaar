#!/usr/bin/env bun
/**
 * Launch speed test — measures the deterministic, server-side phases of a YAAR
 * launch so regressions are catchable in numbers instead of by feel.
 *
 * It does NOT measure external API latency (Hugging Face, arXiv, the Vercel
 * marketplace) or the LLM turn — those dominate app-open time but live outside
 * this repo and vary run to run. What it measures is what our code controls:
 *
 *   1. per-app compile (only paid at boot for stale apps / deploy)
 *   2. listApps()   — runs on GET /api/apps, every app-agent profile build,
 *                     and every describe/query MCP call (all uncached today)
 *   3. served dist/index.html size — the bytes an iframe fetches on every open
 *
 * Run from the repo:  bun packages/server/scripts/launch-speed-test.ts
 * Filter apps:        bun packages/server/scripts/launch-speed-test.ts recent-papers market-apps
 */
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { initCompiler, compileTypeScript } from '../../compiler/src/index.js';
import { listApps, invalidateAppsCache } from '../src/features/apps/discovery.js';

const PROJECT_ROOT = join(import.meta.dir, '..', '..', '..');
const APPS_DIR = join(PROJECT_ROOT, 'apps');
initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: false });

const filter = process.argv.slice(2);

function ms(n: number) {
  return `${n.toFixed(1)}ms`;
}
async function timeN(n: number, fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    total += performance.now() - t;
  }
  return total / n;
}

// ---- gather apps ----
const apps: { id: string; path: string; bundles?: string[]; title: string }[] = [];
for (const name of (await readdir(APPS_DIR)).filter((n) => !n.startsWith('.'))) {
  const p = join(APPS_DIR, name);
  try {
    if (!(await stat(p)).isDirectory()) continue;
    await stat(join(p, 'src', 'main.ts'));
  } catch {
    continue;
  }
  if (filter.length && !filter.includes(name)) continue;
  let bundles: string[] | undefined;
  let title = name;
  try {
    const meta = JSON.parse(await Bun.file(join(p, 'app.json')).text());
    if (Array.isArray(meta.bundles)) bundles = meta.bundles;
    if (typeof meta.name === 'string') title = meta.name;
  } catch {}
  apps.push({ id: name, path: p, bundles, title });
}

// ---- 1. listApps() — hot path, now cached (5s TTL, invalidated on mutations) ----
const all = await listApps();
// Cold: force a full disk scan each iteration by dropping the cache first.
const coldMs = await timeN(20, async () => {
  invalidateAppsCache();
  return listApps();
});
// Cached: repeated calls within one desktop load / agent turn hit the cache.
const cachedMs = await timeN(20, () => listApps());
console.log(`\n[1] listApps() over ${all.length} apps`);
console.log(`    cold (full disk scan): ${ms(coldMs)}   cached hit: ${ms(cachedMs)}`);
console.log(`    called on: GET /api/apps, every profile build, every describe/query MCP call`);
console.log(
  `    a turn with 3 describe calls: ${ms(coldMs)} once, then ~${ms(cachedMs)} each ` +
    `(was ~${ms(coldMs * 3)} of pure re-scan before caching)`,
);

// ---- 2. per-app compile + served size ----
console.log(`\n[2] per-app compile (warm SDK cache) + served dist size`);
if (apps[0]) await compileTypeScript(apps[0].path, { title: apps[0].title, bundles: apps[0].bundles });
const rows: { id: string; ms: number; bytes: number }[] = [];
for (const a of apps) {
  const t = performance.now();
  const r = await compileTypeScript(a.path, { title: a.title, bundles: a.bundles });
  const dt = performance.now() - t;
  let bytes = 0;
  try {
    bytes = (await stat(join(a.path, 'dist', 'index.html'))).size;
  } catch {}
  rows.push({ id: a.id, ms: r.success ? dt : -1, bytes });
}
rows.sort((x, y) => y.ms - x.ms);
for (const r of rows) {
  console.log(
    `    ${r.id.padEnd(20)} ${(r.ms < 0 ? 'FAIL' : r.ms.toFixed(0) + 'ms').padStart(7)}  ` +
      `${(r.bytes / 1024).toFixed(0)}KB served`,
  );
}
const ok = rows.filter((r) => r.ms >= 0);
const totalMs = ok.reduce((s, r) => s + r.ms, 0);
console.log(
  `\n    boot compile: ${ms(totalMs)} serial / ~${ms(totalMs / 4)} at CONCURRENCY=4 (stale apps only)`,
);
const heavy = [...rows].sort((a, b) => b.bytes - a.bytes)[0];
if (heavy) console.log(`    heaviest served bundle: ${heavy.id} ${(heavy.bytes / 1024).toFixed(0)}KB`);
