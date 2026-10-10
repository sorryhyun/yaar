/**
 * Which past session a launch restores from.
 *
 * Split out of `lifecycle.ts` so the choice can be asserted without booting the server —
 * the bug it exists to prevent was invisible from every test in the suite and cost the
 * relaunch its windows.
 */

import type { OSAction } from '@yaar/shared';
import { listSessions, readSessionMessages, parseSessionMessages } from './session-reader.js';
import type { ParsedMessage, SessionInfo } from './types.js';
import { isSubAgentRole } from '../agents/profiles/sub-agent.js';
import { MAX_MONITOR_MESSAGES, extractWindowId } from '../agents/context.js';
import { scopedWindowId } from './window-restore.js';

export interface RestoreSource {
  session: SessionInfo;
  messages: ParsedMessage[];
}

/**
 * The session a launch restores its windows, context, and thread ids from: the most recent
 * one that actually recorded something.
 *
 * Deliberately not `listSessions()[0]`, for two reasons that both make the newest directory
 * the wrong answer:
 *
 *   - **A launch mints its own log.** `createSession()` runs at boot so that a click landing
 *     before the first message is still logged, and that directory sorts first the moment it
 *     exists. Resolving the restore source afterwards read the empty file the boot had just
 *     created, so `restoreActions`, `contextMessages`, `cliEntries` and `savedThreadIds` all
 *     came back empty and every relaunch opened to a bare desktop. `lifecycle.ts` therefore
 *     calls this *before* `createSession()` — but skipping empty logs means the order is no
 *     longer the only thing holding the restore up.
 *   - **An empty log is not a restore point either.** A launch the user closed without typing
 *     leaves one behind; restoring from it is the same nothing, one row down.
 *     `pruneEmptySessions()` clears most, but deliberately keeps those inside its grace window
 *     or held by a live instance — which is exactly the restart-twice-in-a-minute case a
 *     developer hits.
 *
 * Returns null when no session has recorded anything (a fresh checkout, or a `session_logs/`
 * holding only empties). `dir` defaults to the real `session_logs/`.
 */
export async function findRestorableSession(dir?: string): Promise<RestoreSource | null> {
  const sessions = await listSessions(dir);

  for (const session of sessions) {
    const messagesJsonl = await readSessionMessages(session.sessionId, dir);
    if (!messagesJsonl) continue;
    const messages = parseSessionMessages(messagesJsonl);
    if (messages.length === 0) continue;
    return { session, messages };
  }

  return null;
}

/**
 * The entries a launch copies from the session it restored from into its own log.
 *
 * A restore puts the previous session's context and windows back in memory and resumes
 * its provider threads, so the conversation carries on — but the new log used to start
 * blank. Read by a person, it looked like the context had been reset; read by the *next*
 * launch, it was: `findRestorableSession()` picks the newest log with anything in it,
 * which was now one holding only this launch's own activity, so a second restart lost
 * every message and window the first one had carried across.
 *
 * So the log is seeded with exactly what the restore reads back:
 *
 *   - **Context messages** — the user/assistant turns, verbatim (agent, source and
 *     original timestamp intact), minus sub-agent turns that no restore uses — and only
 *     as many as the context tape would be holding (see below).
 *   - **The open windows** — as the `window.create` snapshot `getWindowRestoreActions()`
 *     already reduced them to, not the full action history, so a chain of restarts
 *     carries the desktop forward without re-copying every move and resize.
 *
 * Tool calls, results and thinking are not carried: they feed nothing but the CLI
 * panel's history, and copying them on every restart would grow each log by the whole
 * of the last one.
 *
 * The context messages are bounded the way the live `ContextTape` bounds them, for the
 * same reason. Every carried turn is carried again by the next restart, so copying the
 * whole log made each one hold every turn back to the first launch in the chain — a
 * thousand-odd turns, most of them ones no tape had held for days:
 *
 *   - **Monitor turns** — the last `MAX_MONITOR_MESSAGES`, the tape's own cap.
 *   - **Window branches** — only for the windows still open. The tape drops a branch when
 *     its window closes; the log keeps it, and carrying it on revived it.
 *
 * `lifecycle.ts` restores the tape from these same entries, so what a relaunch remembers
 * and what its log says it remembers cannot drift apart.
 */
export function selectCarryOverEntries(
  messages: ParsedMessage[],
  windowActions: OSAction[],
  now: string = new Date().toISOString(),
): ParsedMessage[] {
  const entries: ParsedMessage[] = [];

  const openWindows = new Set<string>();
  for (const action of windowActions) {
    if (action.type === 'window.create') openWindows.add(scopedWindowId(action.windowId));
  }

  // A turn with no source is a monitor turn — the same default `getContextRestoreMessages` uses.
  const windowOf = (msg: ParsedMessage) =>
    typeof msg.source === 'string' ? extractWindowId(msg.source) : null;
  const context = messages.filter(
    (msg) =>
      (msg.type === 'user' || msg.type === 'assistant') &&
      typeof msg.content === 'string' &&
      !isSubAgentRole(msg.agentId),
  );
  const monitorTurns = context.filter((msg) => windowOf(msg) === null);
  const keptMonitorTurns = new Set(monitorTurns.slice(-MAX_MONITOR_MESSAGES));

  for (const msg of context) {
    const windowId = windowOf(msg);
    const keep =
      windowId === null ? keptMonitorTurns.has(msg) : openWindows.has(scopedWindowId(windowId));
    if (keep) entries.push({ ...msg, restored: true });
  }

  // After the messages, stamped now: the snapshot is the desktop as this launch found it.
  for (const action of windowActions) {
    entries.push({
      type: 'action',
      timestamp: now,
      agentId: null,
      parentAgentId: null,
      action,
      restored: true,
    });
  }

  return entries;
}
