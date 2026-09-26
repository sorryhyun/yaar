/**
 * Process liveness — is a PID currently running?
 */

import { readFileSync } from 'node:fs';

/**
 * Is `pid` a process that currently exists?
 *
 * Signal `0` sends nothing; it only asks the kernel whether the target exists and is
 * signalable. `EPERM` means it exists and belongs to someone else — still alive, just not
 * ours to touch. `ESRCH` (or anything else) means it's gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process's start time from `/proc/<pid>/stat` (field 22, ticks since boot), or `null`
 * when there is no procfs (macOS, Windows) or the process is gone.
 *
 * This is the cheap half of a PID-reuse guard: comparing it against a value read earlier
 * tells a PID's original process apart from an unrelated one handed the same number after
 * it died — which some platforms (Android among them) recycle quickly. One synchronous
 * file read, no subprocess.
 *
 * There is no macOS/Windows equivalent here. Both would need a spawned `ps`/PowerShell
 * call per check to answer the same question, which is what an identity check already
 * pays for when it needs one (see e.g. a command-line match against an expected
 * substring) — not a primitive cheap enough to fold into a plain liveness check.
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Field 2 (comm) is parenthesized and may contain spaces; count from after it.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
