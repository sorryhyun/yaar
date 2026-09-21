#!/usr/bin/env bun
/**
 * mobile.ts — frontend performance of the phone shell under load, with no model in the loop.
 *
 * Launches the server with `YAAR_MOCK_AGENT=1` (providers/mock: every agent turn is a
 * scripted stream that opens real windows through the real `yaar://windows` verb), drives
 * a phone-emulated headless Chrome over CDP, and measures what the *phone* pays:
 *
 *   boot → for each monitor: [create it] → turn (N windows) → idle → swipe across → idle-all
 *
 * The phone is driven like a phone. Monitors are created by pulling the notification shade
 * down and tapping "+", messages are typed into the palette sheet raised by a tap on its
 * handle, and monitors are switched by edge swipes — all real touch streams
 * (`Input.dispatchTouchEvent`), so the gesture code is on the measured path too. Only the
 * agent is fake.
 *
 * Per phase it records:
 *   - frames        rAF deltas in the page: p50/p95/max, frames over 50ms, dropped estimate
 *   - main thread   long tasks and long-animation-frame blocking time
 *   - renderer      Performance.getMetrics deltas: script / layout / style time and counts,
 *                   JS heap, DOM nodes, frames
 *   - latency       turn: message sent → first / last window mounted;
 *                   swipe: finger up → the other monitor's windows on screen
 *   - server        RSS / heap via SIGUSR2
 *
 * It models **Termux**: the phone is both client and server, so the companion desktop
 * (`YAAR_COMPANION_TAB`, on by default on Android) is on too — a second, always-visible
 * desktop in the server's own headless Chromium, keeping every app iframe mounted a second
 * time. On a phone that Chromium shares the one CPU with the user's tab, so it gets the
 * same CPU throttle, its renderer work is recorded beside the phone's, and the process
 * table sums phone Chrome + companion + server as the one device they are.
 * `YAAR_COMPANION_TAB=0` measures the phone-as-remote-client case instead.
 *
 * CPU throttling (`--cpu`, default 4x, what Lighthouse uses for a mid-range phone) applies
 * to each desktop's main renderer. App iframes live on another origin and so in their own
 * process, which CDP's throttle does not reach — their cost shows up in the process table.
 *
 * Usage:
 *   make mobile-bench
 *   make mobile-bench MONITORS=4 WINDOWS=8 APPS=memo,storage CPU=6
 *   bun scripts/bench/mobile.ts --headful --keep-open --no-build
 *
 * Output: bench/mobile/report.md, report.json, server.log
 */

import { Cdp } from '../lib/cdp.ts';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';

const REPO = new URL('../../', import.meta.url).pathname;
const OUT = `${REPO}bench/mobile`;
const CHROME_PROFILE_DIR = `${process.env.HOME}/.yaar-chrome-mobile-bench`;

// ---- args ----
const argv = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const a = Bun.argv[i];
  if (!a.startsWith('--')) continue;
  const next = Bun.argv[i + 1];
  argv.set(a.slice(2), next && !next.startsWith('--') ? next : 'true');
}
const num = (key: string, fallback: number) => {
  const n = Number(argv.get(key));
  return Number.isFinite(n) && argv.has(key) ? n : fallback;
};
// The shell refuses a fifth monitor (MonitorTabs hides "+" at 4), so ask for no more.
const MONITORS = Math.min(Math.max(num('monitors', 3), 1), 4);
const WINDOWS = Math.min(Math.max(num('windows', 6), 1), 24);
const APPS = argv.get('apps') ?? 'memo';
const TEXT = num('text', 600);
const CPU = Math.max(num('cpu', 4), 1);
const SETTLE_S = num('settle', 3);
const [VW, VH] = (argv.get('viewport') ?? '412x915').split('x').map(Number);
const DPR = num('dpr', 2.625);
const HEADLESS = !argv.has('headful');
const KEEP_OPEN = argv.has('keep-open');
const NO_BUILD = argv.has('no-build');
/** Record a CPU profile of the phone's renderer per phase into bench/mobile/profiles/. */
const PROFILE = argv.has('profile');
const TURN_TIMEOUT_MS = 60_000;
const COMPANION = (process.env.YAAR_COMPANION_TAB ?? '1') !== '0';
const WORKSPACE = process.env.YAAR_WORKSPACE ?? 'mobile-bench';
// The server's sandbox browser keeps its profiles here (getBrowserStateDir()).
const BROWSER_STATE_DIR =
  process.env.YAAR_BROWSER_STATE_DIR ?? `${REPO}workspaces/${WORKSPACE}/storage/.browser`;

// ---- process handles ----
let server: Bun.Subprocess | null = null;
let chrome: Bun.Subprocess | null = null;
let cdp: Cdp | null = null;
/** The companion desktop's page, attached through the server's own Chromium. */
let companion: Cdp | null = null;
let cleanedUp = false;

const log = (msg: string) => console.log(`\x1b[35m[mobile-bench]\x1b[0m ${msg}`);
const sleep = (ms: number) => Bun.sleep(ms);

async function sh(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { cwd: REPO, stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

async function pickPort(base: number): Promise<number> {
  for (let p = base; p < base + 20; p++) {
    try {
      Bun.listen({ hostname: '127.0.0.1', port: p, socket: { data() {} } }).stop();
      return p;
    } catch {
      /* in use */
    }
  }
  return base;
}

async function waitHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await sleep(400);
  }
  throw new Error('server did not become healthy in time');
}

const memSnapshots = async () =>
  (
    await Bun.file(`${OUT}/server.log`)
      .text()
      .catch(() => '')
  )
    .split('\n')
    .filter((l) => l.includes('mem-snapshot'));

async function serverMem(): Promise<Record<string, number>> {
  if (!server?.pid) return {};
  const seen = (await memSnapshots()).length;
  process.kill(server.pid, 'SIGUSR2');
  // The server logs the snapshot within milliseconds; wait for the line, not a guess.
  let lines: string[] = [];
  for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(20)) {
    lines = await memSnapshots();
    if (lines.length > seen) break;
  }
  const line = lines.at(-1) ?? '';
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\w+)=([\d.]+)MB/g)) out[m[1]] = Number(m[2]);
  return out;
}

// ---- process trees ----

type Group = 'phone' | 'companion' | 'server';
type ProcSnap = Map<number, { ppid: number; rssMB: number; cpuSec: number; cmd: string }>;

function parseCpuTime(t: string): number {
  // "M:SS.ss", "H:MM:SS" or "SS.ss"
  const parts = t.split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + (n || 0), 0);
}

async function procSnapshot(): Promise<ProcSnap> {
  const p = Bun.spawn(['ps', '-axo', 'pid=,ppid=,rss=,cputime=,command='], { stdout: 'pipe' });
  const out: ProcSnap = new Map();
  for (const line of (await new Response(p.stdout).text()).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m)
      out.set(Number(m[1]), {
        ppid: Number(m[2]),
        rssMB: Number(m[3]) / 1024,
        cpuSec: parseCpuTime(m[4]),
        cmd: m[5],
      });
  }
  return out;
}

/**
 * Which device part a process belongs to, by its nearest classifiable ancestor. Chrome's
 * helpers do not all repeat `--user-data-dir`, but they are all children of a main process
 * that does; the companion's Chromium is itself a child of the server, so it is checked first.
 */
function classify(pid: number, snap: ProcSnap): Group | null {
  for (let cur: number | undefined = pid, hops = 0; cur && hops < 32; hops++) {
    const s = snap.get(cur);
    if (!s) return null;
    if (s.cmd.includes(`--user-data-dir=${CHROME_PROFILE_DIR}`)) return 'phone';
    if (s.cmd.includes(`--user-data-dir=${BROWSER_STATE_DIR}`)) return 'companion';
    if (cur === server?.pid) return 'server';
    cur = s.ppid;
  }
  return null;
}

interface GroupSums {
  groups: Record<Group, { rssMB: number; cpuSec: number }>;
  /** CPU-seconds by `group:process-type` (renderer, gpu-process, …) — where the time goes. */
  byType: Record<string, number>;
}

function sumGroups(snap: ProcSnap): GroupSums {
  const groups = {
    phone: { rssMB: 0, cpuSec: 0 },
    companion: { rssMB: 0, cpuSec: 0 },
    server: { rssMB: 0, cpuSec: 0 },
  };
  const byType: Record<string, number> = {};
  for (const [pid, s] of snap) {
    const g = classify(pid, snap);
    if (!g) continue;
    groups[g].rssMB += s.rssMB;
    groups[g].cpuSec += s.cpuSec;
    const type =
      /--type=(\S+)/.exec(s.cmd)?.[1] ?? (g === 'server' && pid !== server?.pid ? 'child' : 'main');
    const key = `${g}:${type}`;
    byType[key] = (byType[key] ?? 0) + s.cpuSec;
  }
  return { groups, byType };
}

// ---- the in-page probe ----

/**
 * Installed before the desktop's own scripts, so the first frame is on record. rAF deltas
 * are the frame metric because they are what the user sees stall; the two observers say
 * *why* (a long task, or a long animation frame and how much of it blocked input).
 */
const PROBE = String.raw`(() => {
  if (window.__perf) return;
  const P = { frames: [], longTasks: [], loafs: [], last: 0, start: performance.now(), sendAt: 0 };
  const loop = (t) => { if (P.last) P.frames.push(t - P.last); P.last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push(e.duration); })
      .observe({ type: 'longtask' });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.loafs.push({ d: e.duration, b: e.blockingDuration || 0 });
    }).observe({ type: 'long-animation-frame' });
  } catch {}
  P.reset = () => { P.frames = []; P.longTasks = []; P.loafs = []; P.last = 0; P.start = performance.now(); };
  P.take = () => {
    const f = [...P.frames].sort((a, b) => a - b);
    const q = (p) => f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0;
    const r = (n) => Math.round(n * 10) / 10;
    const durationMs = performance.now() - P.start;
    return {
      durationMs: r(durationMs),
      frames: f.length,
      fps: r(f.length / (durationMs / 1000)),
      p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(f.at(-1) || 0),
      over50: f.filter((d) => d > 50).length,
      dropped: f.reduce((n, d) => n + Math.max(0, Math.round(d / (1000 / 60)) - 1), 0),
      longTasks: P.longTasks.length,
      longTaskMs: r(P.longTasks.reduce((a, b) => a + b, 0)),
      loafBlockingMs: r(P.loafs.reduce((a, l) => a + l.b, 0)),
    };
  };
  P.ids = (visibleOnly) => [...document.querySelectorAll(visibleOnly ? '[data-window-id]:not([data-hidden])' : '[data-window-id]')]
    .map((e) => e.getAttribute('data-window-id'));
  // Polled per frame, so "mounted" means "mounted by the frame it was painted in".
  P.waitWindows = (before, n, timeoutMs) => new Promise((resolve) => {
    const seen = new Set(before);
    let first = null;
    const tick = () => {
      const now = performance.now() - P.sendAt;
      const fresh = P.ids(false).filter((id) => !seen.has(id));
      if (fresh.length && first === null) first = now;
      if (fresh.length >= n) return resolve({ first, all: now, count: fresh.length });
      if (now > timeoutMs) return resolve({ first, all: null, count: fresh.length });
      requestAnimationFrame(tick);
    };
    tick();
  });
  P.waitVisibleChange = (before, timeoutMs) => new Promise((resolve) => {
    const key = before.join('|');
    const t0 = performance.now();
    const tick = () => {
      const now = performance.now() - t0;
      if (P.ids(true).join('|') !== key) return resolve(now);
      if (now > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
  window.__perf = P;
})()`;

// ---- touch ----

type Pt = { x: number; y: number };

async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd', p?: Pt): Promise<void> {
  await cdp!.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' || !p ? [] : [{ x: p.x, y: p.y }],
  });
}

async function drag(from: Pt, to: Pt, ms = 260, steps = 16): Promise<void> {
  await touch('touchStart', from);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch('touchMove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    await sleep(ms / steps);
  }
  await touch('touchEnd');
}

async function tap(p: Pt): Promise<void> {
  await touch('touchStart', p);
  await sleep(40);
  await touch('touchEnd');
}

async function center(selector: string): Promise<Pt | null> {
  return cdp!.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`);
}

async function tapSelector(selector: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await center(selector);
    if (p) return tap(p);
    await sleep(100);
  }
  throw new Error(`nothing tappable at ${selector}`);
}

// ---- phone shell actions ----

const PLUS = 'button[title="Create new monitor"]';
const SHADE = '[role="dialog"]';
const HANDLE = 'button[aria-controls="palette-sheet"]';

const monitorCount = () =>
  cdp!.evaluate<number>(`(() => {
    const plus = document.querySelector('${PLUS}');
    return plus ? plus.parentElement.querySelectorAll('button').length - 1 : -1;
  })()`);

/** Pull the shade down from the top edge, tap "+", put the shade away. */
async function createMonitor(): Promise<void> {
  await drag({ x: VW / 2, y: 30 }, { x: VW / 2, y: VH * 0.7 }, 300);
  if (!(await cdp!.waitFor(`document.querySelector('${SHADE}')`, 3000))) {
    throw new Error('the pull-down did not open the notification shade');
  }
  const before = await monitorCount();
  await tapSelector(PLUS);
  // "+" goes away once the fourth monitor exists, so its absence is an answer too.
  const answered = `(() => {
    const plus = document.querySelector('${PLUS}');
    return plus ? plus.parentElement.querySelectorAll('button').length - 1 > ${before} : ${before} >= 3;
  })()`;
  if (!(await cdp!.waitFor(answered, 5000))) {
    throw new Error('the server never answered ADD_MONITOR');
  }
  // Tap the backdrop below the sheet; the shade closes on it.
  const below = await cdp!.evaluate<Pt | null>(`(() => {
    const s = document.querySelector('${SHADE}');
    if (!s) return null;
    const b = s.getBoundingClientRect().bottom;
    return { x: innerWidth / 2, y: Math.min(innerHeight - 8, (b + innerHeight) / 2) };
  })()`);
  if (below) await tap(below);
  if (!(await cdp!.waitFor(`!document.querySelector('${SHADE}')`, 3000))) {
    throw new Error('the shade did not close');
  }
}

/** Raise the palette sheet, type the directive, press Enter — then wait for the windows. */
async function sendTurn(directive: string) {
  const before = await cdp!.evaluate<string[]>(`__perf.ids(false)`);
  await tapSelector(HANDLE);
  if (!(await cdp!.waitFor(`document.activeElement?.tagName === 'TEXTAREA'`, 3000))) {
    throw new Error('the palette sheet did not take focus');
  }
  await cdp!.send('Input.insertText', { text: directive });
  await cdp!.evaluate(`__perf.sendAt = performance.now()`);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  return cdp!.evaluate<{ first: number | null; all: number | null; count: number }>(
    `__perf.waitWindows(${JSON.stringify(before)}, ${WINDOWS}, ${TURN_TIMEOUT_MS})`,
  );
}

/** One edge swipe; `toward` is the neighbour the finger uncovers. */
async function swipe(toward: 'left' | 'right') {
  const before = await cdp!.evaluate<string[]>(`__perf.ids(true)`);
  const y = VH * 0.45;
  // From the gutter the finger starts in: a card's own sideways scroller never sees it.
  if (toward === 'right') await drag({ x: VW - 4, y }, { x: VW * 0.15, y }, 220);
  else await drag({ x: 4, y }, { x: VW * 0.85, y }, 220);
  return cdp!.evaluate<number | null>(`__perf.waitVisibleChange(${JSON.stringify(before)}, 3000)`);
}

// ---- phases ----

type Metrics = Record<string, number>;
interface PhaseRecord {
  phase: string;
  page: Record<string, number>;
  renderer: Metrics;
  /** The companion desktop's renderer, when it is on. */
  companion?: Metrics;
  /** Whole process trees, summed: on Termux, all three are the one phone. */
  procs: Record<Group, { rssMB: number; cpuPct: number }>;
  /** CPU % by `group:process-type`. */
  cpuByType: Record<string, number>;
  server: Record<string, number>;
  windows: { mounted: number; visible: number; iframes: number };
  latency?: Record<string, number | null>;
}
const records: PhaseRecord[] = [];

async function rendererMetrics(target: Cdp): Promise<Metrics> {
  const { metrics } = await target.send('Performance.getMetrics');
  return Object.fromEntries(
    (metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]),
  );
}

function rendererDelta(before: Metrics, now: Metrics): Metrics {
  const delta = (k: string) => (now[k] ?? 0) - (before[k] ?? 0);
  const ms = (s: number) => Math.round(s * 1000);
  return {
    scriptMs: ms(delta('ScriptDuration')),
    layoutMs: ms(delta('LayoutDuration')),
    styleMs: ms(delta('RecalcStyleDuration')),
    taskMs: ms(delta('TaskDuration')),
    layouts: delta('LayoutCount'),
    styleRecalcs: delta('RecalcStyleCount'),
    heapMB: Math.round(((now.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10,
    nodes: now.Nodes ?? 0,
    listeners: now.JSEventListeners ?? 0,
    frames: now.Frames ?? 0,
  };
}

let phaseMetrics: Metrics = {};
let companionMetrics: Metrics = {};
let phaseProcs: { at: number; sums: GroupSums } | null = null;
async function beginPhase(): Promise<void> {
  await cdp!.evaluate('__perf.reset()');
  phaseMetrics = await rendererMetrics(cdp!);
  if (companion) companionMetrics = await rendererMetrics(companion).catch(() => ({}));
  phaseProcs = { at: performance.now(), sums: sumGroups(await procSnapshot()) };
  if (PROFILE) await cdp!.send('Profiler.start');
}

async function endPhase(phase: string, latency?: PhaseRecord['latency']): Promise<void> {
  const page = await cdp!.evaluate<Record<string, number>>('__perf.take()');
  if (PROFILE) {
    const { profile } = await cdp!.send('Profiler.stop');
    await Bun.write(`${OUT}/profiles/${phase}.cpuprofile`, JSON.stringify(profile));
  }
  const renderer = rendererDelta(phaseMetrics, await rendererMetrics(cdp!));
  let companionRenderer: Metrics | undefined;
  if (companion) {
    const now = await rendererMetrics(companion).catch(() => null);
    if (now) {
      companionRenderer = rendererDelta(companionMetrics, now);
      companionRenderer.iframes = await companion
        .evaluate<number>(`document.querySelectorAll('iframe').length`)
        .catch(() => -1);
    }
  }
  // CPU% over the phase from cputime deltas; 100% = one core busy. Processes that were
  // born or died inside the phase make this approximate, which is fine for a table.
  const { groups: procsNow, byType: typesNow } = sumGroups(await procSnapshot());
  const seconds = (performance.now() - (phaseProcs?.at ?? performance.now())) / 1000;
  const pct = (now: number, before = 0) =>
    seconds > 0 ? Math.round((Math.max(0, now - before) / seconds) * 100) : 0;
  const procs = Object.fromEntries(
    (Object.keys(procsNow) as Group[]).map((g) => [
      g,
      {
        rssMB: Math.round(procsNow[g].rssMB),
        cpuPct: pct(procsNow[g].cpuSec, phaseProcs?.sums.groups[g].cpuSec),
      },
    ]),
  ) as PhaseRecord['procs'];
  const cpuByType = Object.fromEntries(
    Object.entries(typesNow).map(([k, v]) => [k, pct(v, phaseProcs?.sums.byType[k])]),
  );
  const windows = await cdp!.evaluate<PhaseRecord['windows']>(`({
    mounted: __perf.ids(false).length,
    visible: __perf.ids(true).length,
    iframes: document.querySelectorAll('iframe').length,
  })`);
  records.push({
    phase,
    page,
    renderer,
    companion: companionRenderer,
    procs,
    cpuByType,
    server: await serverMem(),
    windows,
    latency,
  });
  const lat = latency
    ? ` ${Object.entries(latency)
        .map(([k, v]) => `${k}=${v ?? '∅'}ms`)
        .join(' ')}`
    : '';
  log(
    `${phase}: p95 ${page.p95}ms, max ${page.max}ms, dropped ${page.dropped}, ` +
      `long tasks ${page.longTaskMs}ms, heap ${renderer.heapMB}MB, nodes ${renderer.nodes}${lat}`,
  );
}

async function hold(phase: string): Promise<void> {
  await beginPhase();
  await sleep(SETTLE_S * 1000);
  await endPhase(phase);
}

// ---- report ----

async function writeReport(port: number, pinnedUi: boolean): Promise<void> {
  const md: string[] = [];
  md.push('# YAAR mobile performance (mock agent)\n');
  md.push(
    `- viewport ${VW}×${VH} @${DPR}x · CPU throttle ${CPU}x · headless ${HEADLESS} · port ${port}`,
    `- ${MONITORS} monitor(s) × ${WINDOWS} window(s) · apps: ${APPS || 'none'} · streamed text ${TEXT} chars`,
    pinnedUi
      ? '- ⚠ the media query did not pick the phone shell; the run pinned it with `?ui=mobile`'
      : '- phone shell reached by media query (coarse pointer, narrow viewport)',
    COMPANION
      ? '- Termux model: companion desktop on, same CPU throttle as the phone'
      : '- companion desktop off (phone as a remote client)',
    `- frontend served by the dev bundler with React's ${process.env.YAAR_REACT_PROD === '0' ? 'development' : 'production'} build (what \`make termux\` serves)`,
    '',
  );

  md.push('## Frames (page rAF)\n');
  md.push(
    '| phase | s | fps | p50 | p95 | p99 | max | >50ms | dropped | long tasks ms | LoAF blocking ms |',
  );
  md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of records) {
    const p = r.page;
    md.push(
      `| ${r.phase} | ${(p.durationMs / 1000).toFixed(1)} | ${p.fps} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.max} | ${p.over50} | ${p.dropped} | ${p.longTaskMs} | ${p.loafBlockingMs} |`,
    );
  }

  md.push('\n## Renderer work (Performance.getMetrics, delta over the phase)\n');
  md.push(
    '| phase | script ms | layout ms | style ms | task ms | layouts | style recalcs | heap MB | DOM nodes | listeners | frames |',
  );
  md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of records) {
    const m = r.renderer;
    md.push(
      `| ${r.phase} | ${m.scriptMs} | ${m.layoutMs} | ${m.styleMs} | ${m.taskMs} | ${m.layouts} | ${m.styleRecalcs} | ${m.heapMB} | ${m.nodes} | ${m.listeners} | ${m.frames} |`,
    );
  }

  if (records.some((r) => r.companion)) {
    md.push('\n## Companion desktop renderer (delta over the phase)\n');
    md.push(
      '| phase | script ms | layout ms | style ms | task ms | heap MB | DOM nodes | iframes |',
    );
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of records) {
      const m = r.companion;
      if (!m) continue;
      md.push(
        `| ${r.phase} | ${m.scriptMs} | ${m.layoutMs} | ${m.styleMs} | ${m.taskMs} | ${m.heapMB} | ${m.nodes} | ${m.iframes} |`,
      );
    }
  }

  md.push('\n## Process trees (CPU % of one core over the phase, RSS MB)\n');
  md.push(
    COMPANION
      ? 'On Termux these are one device: the total is what the phone pays.\n'
      : 'The phone column is the device; server runs elsewhere.\n',
  );
  if (CPU > 1) {
    // Measured: the same run idles at ~8% (phone) and ~2% (companion) unthrottled, and at
    // ~77% each under 4x — CDP's throttle spins in the renderer it slows. Its main-thread
    // work (the renderer tables above) is not inflated; this table is.
    md.push(
      `⚠ Under the ${CPU}x CDP throttle each throttled renderer burns ~75% of a core on the ` +
        'throttle itself, so these CPU figures are only comparable between phases, not ' +
        'absolute. For the real idle cost run with `CPU=1`.\n',
    );
  }
  md.push(
    '| phase | phone CPU | companion CPU | server CPU | total CPU | phone RSS | companion RSS | server RSS | total RSS |',
  );
  md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of records) {
    const { phone, companion: c, server: sv } = r.procs;
    md.push(
      `| ${r.phase} | ${phone.cpuPct} | ${c.cpuPct} | ${sv.cpuPct} | ${phone.cpuPct + c.cpuPct + sv.cpuPct} | ${phone.rssMB} | ${c.rssMB} | ${sv.rssMB} | ${phone.rssMB + c.rssMB + sv.rssMB} |`,
    );
  }

  // Where an idle phone's CPU goes: a desktop at rest should cost next to nothing, so
  // anything above noise here is a finding in itself.
  const idle = records.at(-1);
  if (idle) {
    const busy = Object.entries(idle.cpuByType)
      .filter(([, v]) => v >= 3)
      .sort((a, b) => b[1] - a[1]);
    md.push(`\n### CPU by process type during \`${idle.phase}\`\n`);
    md.push('| process | CPU % |\n|---|---:|');
    for (const [k, v] of busy) md.push(`| ${k} | ${v} |`);
    if (!busy.length) md.push('| (all under 3%) | |');
  }

  const withLatency = records.filter((r) => r.latency);
  if (withLatency.length) {
    md.push('\n## Latency\n');
    md.push('| phase | measure | ms |\n|---|---|---:|');
    for (const r of withLatency) {
      for (const [k, v] of Object.entries(r.latency!))
        md.push(`| ${r.phase} | ${k} | ${v ?? 'timeout'} |`);
    }
  }

  md.push('\n## Windows and server\n');
  md.push('| phase | mounted | visible | iframes | server RSS MB | server heap MB |');
  md.push('|---|---:|---:|---:|---:|---:|');
  for (const r of records) {
    md.push(
      `| ${r.phase} | ${r.windows.mounted} | ${r.windows.visible} | ${r.windows.iframes} | ${r.server.rss ?? '-'} | ${r.server.jscHeap ?? r.server.heapUsed ?? '-'} |`,
    );
  }
  md.push('\nRaw: `bench/mobile/report.json`, server output: `bench/mobile/server.log`.\n');

  const text = md.join('\n');
  await Bun.write(`${OUT}/report.md`, text);
  await Bun.write(
    `${OUT}/report.json`,
    JSON.stringify(
      {
        config: { VW, VH, DPR, CPU, MONITORS, WINDOWS, APPS, TEXT, HEADLESS, COMPANION, pinnedUi },
        records,
      },
      null,
      2,
    ),
  );
  console.log('\n' + text);
  log('report written to bench/mobile/report.md');
}

// ---- lifecycle ----

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  companion?.close();
  if (chrome?.pid && !KEEP_OPEN) {
    // Browser.close first: a SIGTERM to the pid Bun spawned left macOS Chrome's whole tree
    // running (reparented to launchd), one per run. The profile sweep catches the rest.
    await Promise.race([cdp?.send('Browser.close').catch(() => {}), sleep(2000)]);
    try {
      chrome.kill();
    } catch {}
    await Promise.race([chrome.exited, sleep(5000)]);
    Bun.spawnSync(['pkill', '-f', `--user-data-dir=${CHROME_PROFILE_DIR}`]);
  }
  cdp?.close();
  if (server?.pid && !KEEP_OPEN) {
    try {
      process.kill(server.pid, 'SIGTERM');
    } catch {}
    await Promise.race([server.exited, sleep(10_000)]);
  }
}

process.on('SIGINT', async () => {
  log('interrupted — cleaning up');
  await cleanup();
  process.exit(130);
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const f of ['server.log', 'report.md', 'report.json'])
    rmSync(`${OUT}/${f}`, { force: true });

  if (!NO_BUILD) {
    // The server imports all three from dist/, and `bun src/main.ts` runs no prebuild hook.
    log('building @yaar/shared + @yaar/lib + @yaar/compiler…');
    await sh(['bun', 'run', '--filter', '@yaar/shared', 'build']);
    // Both depend on shared alone, not on each other.
    await Promise.all([
      sh(['bun', 'run', '--filter', '@yaar/lib', 'build']),
      sh(['bun', 'run', '--filter', '@yaar/compiler', 'build']),
    ]);
  }

  // Our own workspace is scratch: wipe it, or the session restores the last run's windows
  // and every phase starts from them. One the caller named is theirs, so it is left alone.
  if (!process.env.YAAR_WORKSPACE) {
    rmSync(`${REPO}workspaces/${WORKSPACE}`, { recursive: true, force: true });
  }

  const port = await pickPort(8000);
  const serverFd = openSync(`${OUT}/server.log`, 'w');
  log(`launching server with the mock agent on :${port}`);
  server = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: `${REPO}packages/server`,
    env: {
      ...process.env,
      PROVIDER: 'claude',
      YAAR_MOCK_AGENT: '1',
      MCP_SKIP_AUTH: '1',
      PORT: String(port),
      // Each run is a fresh desktop: no session to restore, nothing left over to measure.
      YAAR_WORKSPACE: WORKSPACE,
      // Termux: the server is on the phone, so the companion is on as it would be there.
      YAAR_COMPANION_TAB: COMPANION ? '1' : '0',
      // What a phone gets: on Android the dev bundler ships production React.
      YAAR_REACT_PROD: process.env.YAAR_REACT_PROD ?? '1',
    },
    stdout: serverFd,
    stderr: serverFd,
  });
  await waitHealth(port);
  log('server healthy');

  const chromeBin = findChrome();
  if (!chromeBin) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  const debugPort = await pickPort(9340);
  rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
  chrome = Bun.spawn(
    [
      chromeBin,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Decided once at renderer start: `ontouchstart` and the TouchEvent constructors.
      '--touch-events=enabled',
      `--window-size=${VW},${VH}`,
      ...(HEADLESS ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  cdp = await Cdp.attachToPage(debugPort, 'about:blank', 30_000);

  // DevTools device mode, set before the desktop loads so its first media query is a phone's.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW,
    height: VH,
    deviceScaleFactor: DPR,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp
    .send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
    .catch(() => {});
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  if (PROFILE) {
    rmSync(`${OUT}/profiles`, { recursive: true, force: true });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

  const origin = `http://localhost:${port}`;
  await cdp.send('Page.navigate', { url: `${origin}/?ui=auto` });
  if (!(await cdp.waitFor(`document.querySelector('${HANDLE}')`, 60_000))) {
    const coarse = await cdp.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`);
    if (coarse) throw new Error('desktop did not render the phone shell');
  }
  let pinnedUi = false;
  if (!(await center(HANDLE))) {
    // Some headless builds never report a coarse pointer. The layout is what is being
    // measured, not the detection, so pin it — and say so in the report.
    log('media query did not pick the phone shell — pinning ?ui=mobile');
    pinnedUi = true;
    await cdp.send('Page.navigate', { url: `${origin}/?ui=mobile` });
    if (!(await cdp.waitFor(`document.querySelector('${HANDLE}')`, 60_000))) {
      throw new Error('phone shell did not render');
    }
  }
  await cdp.waitFor(`!document.querySelector('textarea')?.disabled`, 30_000);
  log('phone shell up');
  if (COMPANION) companion = await attachCompanion(port);

  await hold('boot');

  const directive = `perf windows=${WINDOWS} text=${TEXT} apps=${APPS || 'none'}`;
  for (let m = 0; m < MONITORS; m++) {
    if (m > 0) {
      await beginPhase();
      await createMonitor();
      await endPhase(`m${m}-create`);
    }
    await beginPhase();
    const t = await sendTurn(directive);
    await endPhase(`m${m}-turn`, { firstWindow: fmt(t.first), allWindows: fmt(t.all) });
    if (t.all === null) log(`  ! only ${t.count}/${WINDOWS} windows mounted before the timeout`);
    await hold(`m${m}-idle`);
  }

  if (MONITORS > 1) {
    await beginPhase();
    const latency: Record<string, number | null> = {};
    // We are on the last monitor; walk to the first and back, never off either end
    // (left of the first monitor is the CLI).
    for (let i = MONITORS - 1; i > 0; i--) latency[`m${i}→m${i - 1}`] = fmt(await swipe('left'));
    for (let i = 0; i < MONITORS - 1; i++) latency[`m${i}→m${i + 1}`] = fmt(await swipe('right'));
    await endPhase('swipe', latency);
  }

  await hold('idle-all');

  log('done driving — winding down');
  await cleanup();
  await writeReport(port, pinnedUi);
}

/**
 * Find the server's Chromium by its profile dir, read its debug port out of
 * `DevToolsActivePort` (it launches on port 0), and attach to the desktop page it parked.
 */
async function attachCompanion(port: number): Promise<Cdp | null> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snap = await procSnapshot();
    for (const s of snap.values()) {
      const m = new RegExp(`--user-data-dir=(${BROWSER_STATE_DIR}\\S*)`).exec(s.cmd);
      if (!m || s.cmd.includes('--type=')) continue;
      const portFile = await Bun.file(`${m[1]}/DevToolsActivePort`)
        .text()
        .catch(() => '');
      const debugPort = Number(portFile.split('\n')[0]);
      if (!debugPort) continue;
      try {
        const target = await Cdp.attachToPage(debugPort, `:${port}`, 5000);
        await target.send('Emulation.setCPUThrottlingRate', { rate: CPU });
        await target.send('Performance.enable', { timeDomain: 'timeTicks' });
        log(`companion desktop attached (debug port ${debugPort}), throttled ${CPU}x`);
        return target;
      } catch {
        /* the tab is not on the desktop yet */
      }
    }
    await sleep(1000);
  }
  log('  ! companion desktop never appeared — measuring without it (see server.log)');
  return null;
}

function fmt(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

main()
  .catch(async (err) => {
    console.error('\x1b[31m[mobile-bench] failed:\x1b[0m', err?.message ?? err);
    await cleanup();
    process.exit(1);
  })
  .then(() => process.exit(0));
