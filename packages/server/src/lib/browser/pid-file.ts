/**
 * PID file tracking and stale Chrome cleanup.
 *
 * Separated from chrome.ts so that tests can import these functions
 * without being affected by mock.module() applied to chrome.js in
 * other test files (Bun shares the mock registry across test files).
 */

import { rm, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { isProcessAlive, readProcessStartTime } from '@yaar/lib/process';
import { readProcessCommandLine } from '@yaar/lib/win32';
import { createLogger } from '../../observability/log.js';

const log = createLogger('browser');

interface PidRecord {
  pid: number;
  userDataDir: string;
  /**
   * The YAAR server that launched this Chrome. Absent in records written before
   * instances were told apart, which are treated as orphans — the old behaviour.
   */
  ownerPid?: number;
  /** The owner's start time where procfs has one (Linux, Android) — a PID-reuse guard. */
  ownerStart?: string;
}

/**
 * Everything this module leaves in the temp dir is keyed by the server PID that owns it.
 *
 * It used to be one fixed `yaar-browser.pid` and a blanket sweep of every
 * `yaar-browser-*` dir, which made two YAARs on one machine each other's stale state:
 * the second instance's first launch killed the first one's Chrome and deleted its
 * scratch profile and download captures. The PID in the name is what lets a sweep
 * tell "left behind by a server that is gone" from "in use by one that is running".
 * The server PID and not the port or the state dir, because it is the one key that is
 * unique among running instances *and* answers "is the owner still alive?" by itself.
 */
const PID_FILE_NAME = /^yaar-browser(?:-(\d+))?\.pid$/;
const OWNED_DIR_NAME = /^yaar-browser-(?:dl-)?(\d+)-/;

/** This server's PID file. */
function instancePidFile(dir = tmpdir()): string {
  return join(dir, `yaar-browser-${process.pid}.pid`);
}

/**
 * The `mkdtemp` prefix for this server's scratch dirs — the ephemeral profile, and
 * each session's download capture. Only a sweep run after this server is gone removes
 * them (see {@link cleanupStaleChrome}).
 */
export function instanceTempPrefix(kind: 'profile' | 'downloads'): string {
  const tag = kind === 'downloads' ? 'dl-' : '';
  return join(tmpdir(), `yaar-browser-${tag}${process.pid}-`);
}

interface CleanupOptions {
  /** Where to look for PID files and scratch dirs. Defaults to the OS temp dir. */
  tempDir?: string;
}

/** Write PID record so a future server restart can find and kill an orphan. */
export async function writePidFile(
  instance: {
    process: { pid: number };
    userDataDir: string;
  },
  pidFile = instancePidFile(),
): Promise<void> {
  try {
    const ownerStart = readProcessStartTime(process.pid);
    const record: PidRecord = {
      pid: instance.process.pid,
      userDataDir: instance.userDataDir,
      ownerPid: process.pid,
      ...(ownerStart ? { ownerStart } : {}),
    };
    await writeFile(pidFile, JSON.stringify(record));
  } catch {
    /* non-critical — stale cleanup on next restart just won't find this run */
  }
}

/** Remove the PID file (called on clean shutdown). */
export async function removePidFile(pidFile = instancePidFile()): Promise<void> {
  try {
    await rm(pidFile, { force: true });
  } catch {
    /* non-critical */
  }
}

/**
 * Whether the server behind a PID file is a *running other* YAAR — whose Chrome and
 * PID file are none of our business. Our own PID counts as not running: the only
 * way to find our own record here is a relaunch after our Chrome died, and whatever
 * it names is exactly what that relaunch must clear out of the way.
 */
function ownerIsRunningElsewhere(ownerPid: number, ownerStart?: string): boolean {
  if (ownerPid === process.pid) return false;
  if (!isProcessAlive(ownerPid)) return false;
  // A live PID that started at a different time is a stranger holding a recycled number.
  if (ownerStart) {
    const now = readProcessStartTime(ownerPid);
    if (now !== null && now !== ownerStart) return false;
  }
  return true;
}

/**
 * The full command line of a running process, or null when it can't be read.
 * Windows reads it in-process (`@yaar/lib/win32`, a few ms); PowerShell, which blocks the
 * event loop for 1–2 s, is only the fallback for when the FFI call throws.
 * `-ww` because `ps` otherwise truncates to the terminal width, which can cut off
 * the very flag {@link isRecordedChrome} matches on.
 */
function readCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      return readProcessCommandLine(pid);
    } catch {
      // FFI unavailable — take the PowerShell path below.
    }
  }
  try {
    const cmd =
      process.platform === 'win32'
        ? [
            'powershell',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ]
        : ['ps', '-ww', '-p', String(pid), '-o', 'command='];
    const result = Bun.spawnSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a live PID is still the Chrome this record describes.
 *
 * A PID file outlives its process whenever the server dies without cleanup, and PIDs
 * are recycled — after a reboot, or just a long uptime — so a live PID from an old
 * record can belong to anything, the user's own browser included. `--user-data-dir`
 * names a directory only our launch uses (see `launchChrome`), so it is the proof;
 * anything we can't read is treated as not ours.
 */
function isRecordedChrome(record: PidRecord): boolean {
  if (!record.userDataDir) return false;
  const commandLine = readCommandLine(record.pid);
  return commandLine !== null && commandLine.includes(`--user-data-dir=${record.userDataDir}`);
}

/**
 * Clean up what YAAR servers that are no longer running left behind.
 * Called before every launch of the sandbox Chrome.
 *
 * 1. Every `yaar-browser[-<ownerPid>].pid` whose owner is gone (or is this server —
 *    a relaunch) → kill the Chrome it names, if that PID is still that Chrome.
 * 2. Every `yaar-browser-[dl-]<ownerPid>-*` dir whose owner is gone → remove it.
 *
 * A running instance's files are left alone, so two YAARs can share a machine. So are
 * this server's own dirs: a relaunch after Chrome died runs while this server's
 * sessions — and their download captures — are still alive. Dirs with no owner in
 * their name predate this scheme and are left for the OS's temp reaper; there is no
 * telling whether an older YAAR still running is using one.
 */
export async function cleanupStaleChrome(options: CleanupOptions = {}): Promise<void> {
  const tempDir = options.tempDir ?? tmpdir();
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return; // a temp dir we cannot list has nothing we can clean either
  }

  // 1. PID files → orphaned Chrome processes
  let killedPid = false;
  for (const name of entries) {
    const match = PID_FILE_NAME.exec(name);
    if (!match) continue;
    const pidFile = join(tempDir, name);
    const namedOwner = match[1] ? Number(match[1]) : undefined;

    let record: PidRecord;
    try {
      record = JSON.parse(await readFile(pidFile, 'utf-8'));
    } catch {
      // Unreadable. A running owner may be halfway through writing it; anyone else's
      // is garbage.
      if (namedOwner === undefined || !ownerIsRunningElsewhere(namedOwner)) {
        await removePidFile(pidFile);
      }
      continue;
    }

    const ownerPid = namedOwner ?? record.ownerPid;
    if (ownerPid !== undefined && ownerIsRunningElsewhere(ownerPid, record.ownerStart)) continue;

    if (killRecordedChrome(record)) killedPid = true;
    await removePidFile(pidFile);
  }

  // Give killed process time to release resources (ports, file locks)
  if (killedPid) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. Scratch dirs whose owner is gone
  for (const name of entries) {
    const match = OWNED_DIR_NAME.exec(name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;
    await rm(join(tempDir, name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Kill the Chrome a record names, if that PID is still that Chrome. True if signalled. */
function killRecordedChrome(record: PidRecord): boolean {
  // Integer check first: the PID is interpolated into the Windows lookup command.
  const livePid = Number.isInteger(record.pid) && record.pid > 0 && isProcessAlive(record.pid);
  if (!livePid) return false;
  if (!isRecordedChrome(record)) {
    log.info('PID from a stale PID file is no longer our Chrome — leaving it alone', {
      pid: record.pid,
    });
    return false;
  }
  log.info('killing stale Chrome process', { pid: record.pid });
  try {
    process.kill(record.pid, 'SIGKILL');
    return true;
  } catch {
    return false; /* process died between check and kill — fine */
  }
}
