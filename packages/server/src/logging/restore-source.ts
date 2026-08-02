/**
 * Which past session a launch restores from.
 *
 * Split out of `lifecycle.ts` so the choice can be asserted without booting the server —
 * the bug it exists to prevent was invisible from every test in the suite and cost the
 * relaunch its windows.
 */

import { listSessions, readSessionMessages, parseSessionMessages } from './session-reader.js';
import type { ParsedMessage, SessionInfo } from './types.js';

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
