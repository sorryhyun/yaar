/**
 * Exit with the launcher, however the launcher went.
 *
 * `scripts/dev/start.sh` runs the server as a background job under `set -m`, which puts it
 * in a process group of its own: out of reach of the terminal's hangup, so the only thing
 * that stops it is start.sh's cleanup trap. A trap does not run on SIGKILL, and on Android
 * that is how a launcher usually dies — Termux kills a closed session's process outright,
 * and so does the phantom-process killer. The server then lives on as an orphan holding the
 * port, the next `yaar` quietly binds the port above it, and the installed app keeps
 * opening the orphan.
 *
 * So the launcher names itself (`YAAR_LAUNCHER_PID`, set by start-termux.sh) and the server
 * checks on it, shutting down the normal way once it is gone. Unset, nothing is watched.
 */

import { readFileSync } from 'fs';
import { createLogger } from './observability/log.js';

const log = createLogger('launcher');

const POLL_MS = 2_000;

/**
 * The process's start time from `/proc/<pid>/stat` (field 22), or null where there is no
 * procfs. It is what tells the launcher apart from an unrelated process that was handed
 * its PID after it died — Android recycles PIDs quickly.
 */
function readStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Field 2 (comm) is parenthesized and may contain spaces; count from after it.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function isAlive(pid: number, startTime: string | null): boolean {
  if (startTime !== null) return readStartTime(pid) === startTime;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Call `onGone` once, as soon as the process `pid` is no longer running (checked right
 * away, then every `pollMs`). Returns the function that stops watching.
 */
export function watchProcess(pid: number, onGone: () => void, pollMs = POLL_MS): () => void {
  const startTime = readStartTime(pid);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const check = () => {
    if (isAlive(pid, startTime)) return;
    stop();
    onGone();
  };
  timer = setInterval(check, pollMs);
  timer.unref?.();
  check();
  return stop;
}

/**
 * Watch the process named by `YAAR_LAUNCHER_PID`, if any, and run `shutdown` when it is
 * gone. The variable is removed from the environment once read, so the agents and tools
 * this server spawns do not inherit a launcher that is not theirs.
 */
export function watchLauncher(shutdown: () => void): (() => void) | null {
  const raw = process.env.YAAR_LAUNCHER_PID;
  delete process.env.YAAR_LAUNCHER_PID;
  if (!raw) return null;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1) {
    log.warn('ignoring YAAR_LAUNCHER_PID: not a process id', { value: raw });
    return null;
  }
  return watchProcess(pid, () => {
    log.warn('launcher exited without stopping the server — shutting down', { pid });
    shutdown();
  });
}
