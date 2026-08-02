/**
 * Empty-session-log pruning.
 *
 * `createSession()` runs at boot (`lifecycle.ts`) so a user interaction is logged from the
 * very first click, before any provider or agent exists. Every launch therefore mints a
 * `session_logs/{timestamp}/` directory whether or not the user ever typed — and a dev loop
 * that restarts the server dozens of times a day leaves dozens of them. They are not merely
 * disk noise: `listSessions()` backs `yaar://history/` and `GET /api/sessions`, so each one
 * is a row the user (and the agent reading its own history) has to look past.
 *
 * So the launch that would create the next one clears out the ones that recorded nothing.
 *
 * Three rules keep this from deleting anything a person would miss:
 *
 * 1. **Empty means empty, structurally.** A directory qualifies only when it holds exactly
 *    the shape `createSession()` lays down — `metadata.json`, a zero-length `messages.jsonl`,
 *    and an `agents/` dir of zero-length files — or nothing at all (a boot that died between
 *    the `mkdir` and the first write). Any unexpected entry, any byte in any log, and it is
 *    kept. A future writer that drops a file in there gets its session preserved for free
 *    rather than silently pruned.
 * 2. **A live server's session is off limits.** `metadata.json` carries the `pid` of the
 *    process that created it; a directory whose owner is still running is skipped, so a second
 *    YAAR instance sitting idle on another port does not get its log deleted out from under it.
 *    PIDs are recycled, so this can only ever *over*-keep.
 * 3. **Nothing newer than the grace window.** Belt to the pid suspenders, and what covers a
 *    session created by a process the pid check cannot see (a pid-less log from an older
 *    build, a container with a separate pid namespace).
 *
 * Never fatal: a prune that throws is logged and the launch continues.
 */

import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { SESSIONS_DIR } from './index.js';
import type { SessionMetadata } from './types.js';

/** How recently a session directory may have been touched and still be pruned. */
const DEFAULT_GRACE_MS = 5 * 60_000;

/** The exact entries `createSession()` creates. Anything else means someone wrote there. */
const EXPECTED_ENTRIES = new Set(['metadata.json', 'messages.jsonl', 'agents']);

export interface PruneOptions {
  /** Directory holding session logs. Defaults to the real `session_logs/`. */
  dir?: string;
  /** Session ids to leave alone regardless (e.g. one just created). */
  keep?: Iterable<string>;
  /** Skip directories touched more recently than this. Defaults to 5 minutes. */
  graceMs?: number;
  /** Clock override for tests. */
  now?: number;
}

/**
 * Is `pid` a process that currently exists?
 *
 * `EPERM` means it exists and belongs to someone else — still alive, still off limits.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Does this directory hold a session that recorded nothing at all?
 *
 * Returns false for anything it cannot fully account for — an unreadable directory, an
 * unexpected entry, a non-empty log, a `metadata.json` that will not parse, or a pid that
 * is still running.
 */
async function isPrunableSession(directory: string, graceCutoff: number): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  // A directory holding nothing at all — a boot that died between `mkdir` and the first
  // write, and the one empty shape with no file mtime to judge by, so its own must do.
  if (entries.length === 0) {
    try {
      return (await stat(directory)).mtimeMs <= graceCutoff;
    } catch {
      return false;
    }
  }

  // Otherwise: exactly the created shape, no more and no less.
  if (entries.length !== EXPECTED_ENTRIES.size) return false;
  for (const entry of entries) {
    if (!EXPECTED_ENTRIES.has(entry.name)) return false;
  }

  try {
    const [metadataStat, messagesStat, agentEntries] = await Promise.all([
      stat(join(directory, 'metadata.json')),
      stat(join(directory, 'messages.jsonl')),
      readdir(join(directory, 'agents'), { withFileTypes: true }),
    ]);

    if (!metadataStat.isFile() || !messagesStat.isFile()) return false;
    if (messagesStat.size > 0) return false;
    if (Math.max(metadataStat.mtimeMs, messagesStat.mtimeMs) > graceCutoff) return false;

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isFile()) return false;
      const agentStat = await stat(join(directory, 'agents', agentEntry.name));
      if (agentStat.size > 0) return false;
      if (agentStat.mtimeMs > graceCutoff) return false;
    }

    const metadata = JSON.parse(
      await Bun.file(join(directory, 'metadata.json')).text(),
    ) as SessionMetadata;
    if (metadata.pid !== undefined && isProcessAlive(metadata.pid)) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Delete session log directories that recorded nothing.
 *
 * Returns the ids of the sessions removed.
 */
export async function pruneEmptySessions(options: PruneOptions = {}): Promise<string[]> {
  const dir = options.dir ?? SESSIONS_DIR;
  const keep = new Set(options.keep ?? []);
  const graceCutoff = (options.now ?? Date.now()) - (options.graceMs ?? DEFAULT_GRACE_MS);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No session_logs/ yet — nothing to prune.
  }

  const pruned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;

    const directory = join(dir, entry.name);
    if (!(await isPrunableSession(directory, graceCutoff))) continue;

    try {
      await rm(directory, { recursive: true, force: true });
      pruned.push(entry.name);
    } catch {
      // A directory we cannot remove is one we keep — the next launch tries again.
    }
  }

  return pruned;
}
