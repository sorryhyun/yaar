#!/usr/bin/env bun
/**
 * bench-resources.ts — sample CPU/RSS of the YAAR process trees over time.
 *
 * YAAR has no built-in resource metrics, so we sample from the OS. Three groups
 * are tracked and reported separately:
 *   - server : `bun` running src/main.ts / dist/main.js  (+ its descendants)
 *   - agent  : the *second* `bun` (claude CLI) and/or `codex app-server`
 *   - chrome : renderer/gpu processes under the yaar chrome profile
 *
 * CPU% is instantaneous, computed from the delta of total CPU-seconds
 * (`ps -o cputime`) between consecutive snapshots — NOT ps's lifetime %cpu.
 *
 * Usage:
 *   bun scripts/bench-resources.ts                       # auto-find server, sample forever
 *   bun scripts/bench-resources.ts --interval 1 --out bench.csv
 *   bun scripts/bench-resources.ts --port 8000 --chrome-profile .yaar-chrome
 *
 * Mark a phase boundary from another shell while it runs:
 *   echo "app-launch:market" > /tmp/yaar-bench-phase
 * (the sampler picks up the file, tags subsequent rows, then clears it)
 *
 * Output: CSV to stdout (and --out file): ts_ms,phase,group,pid,rss_mb,cpu_pct,cmd
 * Plus a per-phase summary table to stderr on exit (Ctrl-C).
 */

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const a = Bun.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), Bun.argv[i + 1] ?? 'true');
}
const INTERVAL = Number(args.get('interval') ?? '1') * 1000;
const OUT = args.get('out');
const PORT = args.get('port') ?? '8000';
const CHROME_PROFILE = args.get('chrome-profile') ?? '.yaar-chrome';
const PHASE_FILE = args.get('phase-file') ?? '/tmp/yaar-bench-phase';

type Snap = { rss: number; cpuSec: number; cmd: string; ppid: number; group: string };

function parseCpuTime(t: string): number {
  // formats: "MM:SS.ss", "HH:MM:SS", "SS.ss"
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

async function snapshot(): Promise<Map<number, Snap>> {
  const p = Bun.spawn(
    ['ps', '-axo', 'pid=,ppid=,rss=,cputime=,command='],
    { stdout: 'pipe' },
  );
  const text = await new Response(p.stdout).text();
  const map = new Map<number, Snap>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, rss, cputime, cmd] = m;
    map.set(Number(pid), {
      rss: Number(rss) / 1024, // KB -> MB
      cpuSec: parseCpuTime(cputime),
      cmd,
      ppid: Number(ppid),
      group: '',
    });
  }
  return map;
}

// Find the YAAR server bun PID: a `bun` process whose command mentions main.ts / server.
function findServerPid(map: Map<number, Snap>): number | null {
  for (const [pid, s] of map) {
    if (/\bbun\b/.test(s.cmd) && /(server\/src\/main\.ts|@yaar\/server|dist\/main\.js|src\/main\.ts)/.test(s.cmd)) {
      return pid;
    }
  }
  return null;
}

function descendants(root: number, map: Map<number, Snap>): Set<number> {
  const kids = new Map<number, number[]>();
  for (const [pid, s] of map) {
    if (!kids.has(s.ppid)) kids.set(s.ppid, []);
    kids.get(s.ppid)!.push(pid);
  }
  const out = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of kids.get(cur) ?? []) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

function classify(pid: number, s: Snap, serverTree: Set<number>): string | null {
  if (s.cmd.includes(CHROME_PROFILE)) return 'chrome';
  if (/\bcodex\b/.test(s.cmd) && s.cmd.includes('app-server')) return 'agent';
  if (serverTree.has(pid)) {
    // server root vs a claude-cli bun spawned under it
    if (/(server\/src\/main\.ts|@yaar\/server|dist\/main\.js|src\/main\.ts)/.test(s.cmd)) return 'server';
    return 'agent'; // descendant bun / claude cli / mcp helpers
  }
  return null;
}

const rows: { ts: number; phase: string; group: string; rss: number; cpu: number }[] = [];
let phase = 'boot-idle';
let prev: Map<number, Snap> | null = null;
let prevTs = 0;
const outLines: string[] = ['ts_ms,phase,group,pid,rss_mb,cpu_pct,cmd'];

function readPhase() {
  try {
    const f = Bun.file(PHASE_FILE);
    // sync read via spawnSync-free: use readFileSync
    const fs = require('node:fs');
    if (fs.existsSync(PHASE_FILE)) {
      const v = fs.readFileSync(PHASE_FILE, 'utf8').trim();
      if (v) { phase = v; fs.unlinkSync(PHASE_FILE); console.error(`\n=== phase -> ${phase} ===`); }
    }
  } catch {}
}

async function tick() {
  readPhase();
  const now = Date.now();
  const map = await snapshot();
  const serverPid = findServerPid(map);
  const serverTree = serverPid ? descendants(serverPid, map) : new Set<number>();

  const perGroup = { server: { rss: 0, cpu: 0 }, agent: { rss: 0, cpu: 0 }, chrome: { rss: 0, cpu: 0 } };
  const elapsed = prevTs ? (now - prevTs) / 1000 : INTERVAL / 1000;

  for (const [pid, s] of map) {
    const g = classify(pid, s, serverTree);
    if (!g) continue;
    let cpu = 0;
    if (prev?.has(pid)) cpu = ((s.cpuSec - prev.get(pid)!.cpuSec) / elapsed) * 100;
    (perGroup as any)[g].rss += s.rss;
    (perGroup as any)[g].cpu += Math.max(0, cpu);
    outLines.push(`${now},${phase},${g},${pid},${s.rss.toFixed(1)},${Math.max(0, cpu).toFixed(1)},"${s.cmd.slice(0, 60)}"`);
  }

  for (const g of ['server', 'agent', 'chrome'] as const) {
    rows.push({ ts: now, phase, group: g, rss: perGroup[g].rss, cpu: perGroup[g].cpu });
  }
  const tot = perGroup.server.rss + perGroup.agent.rss + perGroup.chrome.rss;
  console.error(
    `[${phase.padEnd(20)}] ` +
    `server ${perGroup.server.rss.toFixed(0)}MB/${perGroup.server.cpu.toFixed(0)}%  ` +
    `agent ${perGroup.agent.rss.toFixed(0)}MB/${perGroup.agent.cpu.toFixed(0)}%  ` +
    `chrome ${perGroup.chrome.rss.toFixed(0)}MB/${perGroup.chrome.cpu.toFixed(0)}%  ` +
    `| total ${tot.toFixed(0)}MB` +
    (serverPid ? '' : '  (server not found yet)'),
  );

  prev = map;
  prevTs = now;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function summary() {
  console.error('\n================ per-phase summary (median) ================');
  console.error('phase                group     rss_mb   cpu_pct   samples');
  const phases = [...new Set(rows.map((r) => r.phase))];
  for (const ph of phases) {
    for (const g of ['server', 'agent', 'chrome'] as const) {
      const rs = rows.filter((r) => r.phase === ph && r.group === g);
      if (!rs.length) continue;
      console.error(
        `${ph.padEnd(20)} ${g.padEnd(8)} ${median(rs.map((r) => r.rss)).toFixed(0).padStart(8)} ${median(rs.map((r) => r.cpu)).toFixed(0).padStart(9)} ${String(rs.length).padStart(9)}`,
      );
    }
  }
  console.error('===========================================================');
  if (OUT) { Bun.write(OUT, outLines.join('\n')); console.error(`\nCSV written to ${OUT} (${outLines.length - 1} rows)`); }
}

process.on('SIGINT', () => { summary(); process.exit(0); });

console.error(`Sampling every ${INTERVAL / 1000}s. Port ${PORT}, chrome profile "${CHROME_PROFILE}".`);
console.error(`Mark phases with:  echo "app-launch:market" > ${PHASE_FILE}`);
console.error('Ctrl-C to stop and print summary.\n');
// eslint-disable-next-line no-constant-condition
while (true) {
  await tick();
  await Bun.sleep(INTERVAL);
}
