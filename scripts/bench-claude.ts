#!/usr/bin/env bun
/**
 * bench-claude.ts — one-command CPU/memory benchmark of a YAAR Claude session.
 *
 * Launches the server under Bun's CPU/heap profiler, drives a dedicated headless
 * Chrome via CDP to open a set of apps, and samples the whole process tree at
 * each phase. Produces bench/report.md plus the raw artifacts.
 *
 * Measures four things per phase (boot-idle → desktop-open → per-app):
 *   - server RSS / JS heap        (SIGUSR2 handler in main.ts → server.log)
 *   - server CPU flamegraph        (bun --cpu-prof-md, flushed on exit)
 *   - server-tree subprocesses     (scripts/bench-resources.ts: claude CLI + any
 *                                   headless Chrome the app spawns via yaar-web)
 *   - frontend Chrome              (the .yaar-chrome-bench profile, isolated so
 *                                   the sampler's `chrome` group == YAAR's UI)
 *   - frontend JS heap             (performance.memory read over CDP)
 *
 * Usage:
 *   make claude-bench
 *   bun scripts/bench-claude.ts --apps market-apps,thesingularity-reader
 *   bun scripts/bench-claude.ts --settle 5 --headful --keep-open
 */

import { Cdp } from './lib/cdp.ts';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = new URL('../', import.meta.url).pathname;
const BENCH = `${REPO}bench`;
const PHASE_FILE = '/tmp/yaar-bench-phase';
const CHROME_PROFILE_DIR = `${process.env.HOME}/.yaar-chrome-bench`;
const CHROME_PROFILE_NAME = '.yaar-chrome-bench';

// ---- args ----
const argv = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const a = Bun.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = Bun.argv[i + 1];
    if (next && !next.startsWith('--')) argv.set(key, next);
    else argv.set(key, 'true');
  }
}
const APPS = (argv.get('apps') ?? 'market-apps,thesingularity-reader').split(',').filter(Boolean);
const SETTLE_S = Number(argv.get('settle') ?? '4'); // seconds to hold each phase for sampling
const INTERVAL_S = Number(argv.get('interval') ?? '1');
const HEADLESS = !argv.has('headful');
const KEEP_OPEN = argv.has('keep-open');
const NO_BUILD = argv.has('no-build');
// Default to a scanned free port, NOT 9222 — a `make claude-dev` / user Chrome
// commonly already holds 9222, and a second Chrome silently fails to bind it.
let DEBUG_PORT = argv.has('debug-port') ? Number(argv.get('debug-port')) : 0;

// ---- process handles (for cleanup) ----
let server: Bun.Subprocess | null = null;
let sampler: Bun.Subprocess | null = null;
let chrome: Bun.Subprocess | null = null;
let cdp: Cdp | null = null;
let cleanedUp = false;

function log(msg: string) {
  console.log(`\x1b[36m[bench]\x1b[0m ${msg}`);
}

async function sh(cmd: string[], opts: { cwd?: string } = {}): Promise<void> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`);
}

function findChrome(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (require('node:fs').existsSync(c)) return c;
  return null;
}

async function pickPort(base = 8000): Promise<number> {
  for (let p = base; p < base + 20; p++) {
    try {
      const s = Bun.listen({ hostname: '127.0.0.1', port: p, socket: { data() {} } });
      s.stop();
      return p;
    } catch {
      /* in use */
    }
  }
  return base;
}

async function waitHealth(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await Bun.sleep(400);
  }
  throw new Error('server did not become healthy in time');
}

/** Fire SIGUSR2 at the server and return the memory snapshot line it logs. */
async function serverMemSnapshot(): Promise<string> {
  if (!server?.pid) return '';
  process.kill(server.pid, 'SIGUSR2');
  await Bun.sleep(400);
  const text = await Bun.file(`${BENCH}/server.log`).text().catch(() => '');
  const lines = text.split('\n').filter((l) => l.includes('mem-snapshot'));
  return lines.at(-1) ?? '';
}

function parseServerMem(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\w+)=([\d.]+)MB/g)) out[m[1]] = Number(m[2]);
  return out;
}

async function frontendHeap(): Promise<{ usedMB: number; totalMB: number; iframes: number }> {
  if (!cdp) return { usedMB: 0, totalMB: 0, iframes: 0 };
  return cdp.evaluate(`(() => {
    const m = performance.memory || {};
    const mb = n => +(((n||0)/1048576).toFixed(1));
    return { usedMB: mb(m.usedJSHeapSize), totalMB: mb(m.totalJSHeapSize),
             iframes: document.querySelectorAll('iframe').length };
  })()`);
}

async function openAppAndWait(appId: string): Promise<boolean> {
  if (!cdp) return false;
  const clicked = await cdp.evaluate<boolean>(`(() => {
    const btn = document.querySelector('button[data-app-id="${appId}"]:not([disabled])');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  if (!clicked) {
    log(`  ! icon for ${appId} not found (may be inside a folder) — skipping`);
    return false;
  }
  // wait for window + iframe present and (same-origin) loaded
  const ready = await cdp.waitFor(
    `(() => {
      const frame = document.querySelector('[data-window-id$="/${appId}"]');
      const iframe = frame && frame.querySelector('iframe[src*="/api/apps/${appId}/"]');
      if (!frame || !iframe) return false;
      try { return iframe.contentDocument ? iframe.contentDocument.readyState === 'complete' : true; }
      catch { return true; }
    })()`,
    20_000,
  );
  return ready;
}

type PhaseRecord = {
  phase: string;
  serverMem: Record<string, number>;
  frontend: { usedMB: number; totalMB: number; iframes: number };
};
const records: PhaseRecord[] = [];

/** Mark a phase for the sampler, hold it for SETTLE_S, then snapshot server+frontend. */
async function capturePhase(phase: string): Promise<void> {
  await Bun.write(PHASE_FILE, phase);
  log(`phase: ${phase} — holding ${SETTLE_S}s for sampling`);
  await Bun.sleep(SETTLE_S * 1000);
  const memLine = await serverMemSnapshot();
  const frontend = await frontendHeap();
  records.push({ phase, serverMem: parseServerMem(memLine), frontend });
}

// ---- sampler CSV → per-phase group medians ----
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
async function samplerSummary(): Promise<Map<string, Map<string, { rss: number; cpu: number }>>> {
  const text = await Bun.file(`${BENCH}/resources.csv`).text().catch(() => '');
  // columns: ts_ms,phase,group,pid,rss_mb,cpu_pct,cmd
  // sum per (phase,group,ts) then take the median across timestamps
  const byPhaseGroupTs = new Map<string, Map<number, { rss: number; cpu: number }>>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 6) continue;
    const [ts, phase, group, , rss, cpu] = cols;
    const key = `${phase}|${group}`;
    if (!byPhaseGroupTs.has(key)) byPhaseGroupTs.set(key, new Map());
    const tsMap = byPhaseGroupTs.get(key)!;
    const cur = tsMap.get(Number(ts)) ?? { rss: 0, cpu: 0 };
    cur.rss += Number(rss);
    cur.cpu += Number(cpu);
    tsMap.set(Number(ts), cur);
  }
  const out = new Map<string, Map<string, { rss: number; cpu: number }>>();
  for (const [key, tsMap] of byPhaseGroupTs) {
    const [phase, group] = key.split('|');
    if (!out.has(phase)) out.set(phase, new Map());
    out.get(phase)!.set(group, {
      rss: median([...tsMap.values()].map((v) => v.rss)),
      cpu: median([...tsMap.values()].map((v) => v.cpu)),
    });
  }
  return out;
}

async function writeReport(port: number): Promise<void> {
  const sampler = await samplerSummary();
  const phases = ['boot-idle', 'desktop-open', ...APPS];
  const groups = ['server', 'agent', 'chrome'];

  let md = `# YAAR Claude resource benchmark\n\n`;
  md += `- provider: claude · port: ${port} · headless: ${HEADLESS} · settle: ${SETTLE_S}s · interval: ${INTERVAL_S}s\n`;
  md += `- apps launched: ${APPS.join(', ')}\n\n`;

  md += `## Server process (RSS / JS heap, via SIGUSR2)\n\n`;
  md += `| phase | RSS MB | JS heap MB | external MB |\n|---|---:|---:|---:|\n`;
  for (const r of records) {
    md += `| ${r.phase} | ${r.serverMem.rss ?? '-'} | ${r.serverMem.jscHeap ?? r.serverMem.heapUsed ?? '-'} | ${r.serverMem.external ?? '-'} |\n`;
  }

  md += `\n## Process-tree groups (median RSS MB / CPU %, via OS sampler)\n\n`;
  md += `| phase | ${groups.map((g) => `${g} RSS`).join(' | ')} | ${groups.map((g) => `${g} CPU`).join(' | ')} |\n`;
  md += `|---|${groups.map(() => '---:').join('|')}|${groups.map(() => '---:').join('|')}|\n`;
  for (const ph of phases) {
    const g = sampler.get(ph);
    if (!g) continue;
    const rss = groups.map((x) => (g.get(x)?.rss ?? 0).toFixed(0));
    const cpu = groups.map((x) => (g.get(x)?.cpu ?? 0).toFixed(0));
    md += `| ${ph} | ${rss.join(' | ')} | ${cpu.join(' | ')} |\n`;
  }

  md += `\n## Frontend renderer (${CHROME_PROFILE_NAME}) JS heap, via performance.memory\n\n`;
  md += `| phase | used JS heap MB | total JS heap MB | iframes |\n|---|---:|---:|---:|\n`;
  for (const r of records) {
    md += `| ${r.phase} | ${r.frontend.usedMB} | ${r.frontend.totalMB} | ${r.frontend.iframes} |\n`;
  }

  // CPU profile top line
  const cpuFiles = [...require('node:fs').readdirSync(BENCH)].filter((f: string) =>
    /^CPU\..*\.md$/.test(f),
  );
  if (cpuFiles.length) {
    const cpuText = await Bun.file(`${BENCH}/${cpuFiles.at(-1)}`).text();
    const top = cpuText.match(/\*\*Top 10:\*\*.*/);
    const dur = cpuText.match(/\| ([\d.]+s) \| (\d+) \|/);
    md += `\n## Server CPU profile (bun --cpu-prof-md)\n\n`;
    if (dur) md += `- duration ${dur[1]}, ${dur[2]} samples (≈${(Number(dur[2]) / 1000).toFixed(1)}s CPU) — a near-idle server means most CPU lives in subprocesses, not YAAR itself\n`;
    if (top) md += `- ${top[0].replace(/\*\*/g, '')}\n`;
    md += `- full flamegraph: bench/${cpuFiles.at(-1)}\n`;
  }

  md += `\n## Artifacts\n\n- \`bench/resources.csv\` — per-process time series\n- \`bench/server.log\` — mem snapshots + server output\n- \`bench/sampler.log\` — per-phase group summary\n- \`bench/CPU.*.md\` — server CPU flamegraph\n`;

  await Bun.write(`${BENCH}/report.md`, md);
  console.log('\n' + md);
  log(`report written to bench/report.md`);
}

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    cdp?.close();
  } catch {}
  if (chrome?.pid && !KEEP_OPEN) {
    try {
      process.kill(-chrome.pid, 'SIGTERM');
    } catch {
      try {
        chrome.kill();
      } catch {}
    }
  }
  if (sampler?.pid) {
    try {
      process.kill(sampler.pid, 'SIGINT'); // prints summary
    } catch {}
    await Bun.sleep(1200);
  }
  if (server?.pid) {
    try {
      process.kill(server.pid, 'SIGTERM'); // graceful exit flushes cpu-prof
    } catch {}
    // wait up to 15s for the profile to be written on exit
    await Promise.race([server.exited, Bun.sleep(15_000)]);
  }
}

process.on('SIGINT', async () => {
  log('interrupted — cleaning up');
  await cleanup();
  process.exit(130);
});

async function main() {
  await sh(['mkdir', '-p', BENCH]);
  // clear previous profile artifacts so we read the fresh one
  for (const f of require('node:fs').readdirSync(BENCH)) {
    if (/^CPU\..*\.md$/.test(f) || f === 'server.log' || f === 'resources.csv' || f === 'sampler.log')
      require('node:fs').rmSync(`${BENCH}/${f}`, { force: true });
  }

  if (!NO_BUILD) {
    log('building @yaar/shared + @yaar/compiler (needed by server)…');
    await sh(['bun', 'run', '--filter', '@yaar/shared', 'build'], { cwd: REPO });
    await sh(['bun', 'run', '--filter', '@yaar/compiler', 'build'], { cwd: REPO });
  }

  const port = await pickPort(8000);
  const url = `http://127.0.0.1:${port}`;
  log(`launching server (claude) under Bun profiler on ${url}`);
  const fs = require('node:fs');
  const serverFd = fs.openSync(`${BENCH}/server.log`, 'w');
  // Only --cpu-prof-md: it honors an absolute --cpu-prof-dir. --heap-prof-dir
  // strips the leading slash (Bun quirk) and scatters files under a cwd-relative
  // path, and its output is redundant here — SIGUSR2 already samples the heap.
  server = Bun.spawn(
    ['bun', '--cpu-prof-md', `--cpu-prof-dir=${BENCH}`, 'src/main.ts'],
    {
      cwd: `${REPO}packages/server`,
      env: { ...process.env, PROVIDER: 'claude', MCP_SKIP_AUTH: '1', PORT: String(port) },
      stdout: serverFd,
      stderr: serverFd,
    },
  );

  await waitHealth(port);
  log('server healthy');

  // start OS sampler over the server tree + the bench Chrome profile
  sampler = Bun.spawn(
    [
      'bun',
      `${HERE}bench-resources.ts`,
      '--interval',
      String(INTERVAL_S),
      '--out',
      `${BENCH}/resources.csv`,
      '--chrome-profile',
      CHROME_PROFILE_NAME,
      '--port',
      String(port),
    ],
    (() => {
      const fd = fs.openSync(`${BENCH}/sampler.log`, 'w');
      return { cwd: REPO, stdout: fd, stderr: fd };
    })(),
  );
  await Bun.sleep(1500);

  // Phase 1: boot-idle (server up, no browser yet)
  await capturePhase('boot-idle');

  // launch dedicated headless Chrome on an isolated profile + free debug port
  const chromeBin = findChrome();
  if (!chromeBin) throw new Error('No Chrome/Chromium found for the frontend');
  if (!DEBUG_PORT) DEBUG_PORT = await pickPort(9333);
  log(`launching ${HEADLESS ? 'headless ' : ''}Chrome (${CHROME_PROFILE_NAME}) on debug port ${DEBUG_PORT} → ${url}`);
  chrome = Bun.spawn(
    [
      chromeBin,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(HEADLESS ? ['--headless=new'] : []),
      url,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );

  cdp = await Cdp.attachToPage(DEBUG_PORT, `:${port}`, 30_000);
  const desktopReady = await cdp.waitFor(
    `document.querySelector('button[data-app-id]') || document.querySelector('textarea')`,
    30_000,
  );
  if (!desktopReady) throw new Error('desktop did not render');
  log('desktop rendered');

  // Phase 2: desktop-open
  await capturePhase('desktop-open');

  // Phase 3..N: open each app
  for (const appId of APPS) {
    log(`opening app: ${appId}`);
    const ok = await openAppAndWait(appId);
    if (!ok) log(`  ! ${appId} window/iframe not confirmed ready (measuring anyway)`);
    await capturePhase(appId);
  }

  log('done driving — winding down (flushing profiles)');
  await cleanup();
  await writeReport(port);
}

main()
  .catch(async (err) => {
    console.error('\x1b[31m[bench] failed:\x1b[0m', err?.message ?? err);
    await cleanup();
    process.exit(1);
  })
  .then(() => process.exit(0));
