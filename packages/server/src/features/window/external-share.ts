/**
 * External window sharing — an outside MCP client drives one window the user shared.
 *
 * The user presses the share button in a window's titlebar; the server mints a capability
 * token on that window's side record (`WindowStateRegistry.shareExternally`) and answers a
 * URL, `/mcp/x/{token}`. Whoever holds the URL connects to it as an ordinary MCP server and
 * gets exactly the **app agent's** tools for that window — `describe`, `query`, `command`,
 * `relay` — with the app agent's authority: its own storage tree, the shared commons, what
 * its app.json grants, and cross-app control through `controls`. Nothing else is served.
 *
 * No new access tier: the app tools take all of their authority from the context they run
 * in (`getWindowId()`, `getMonitorId()`, `role: 'app'`), so building that context from the
 * share *is* the grant. `role: 'app'` also keeps the two gates an app agent is held to —
 * `mayDelegateGrants` answers false and `session-principal` URIs stay refused.
 *
 * **The URL is the credential, and the window is its lifetime.** Closing the window drops
 * its side record, and the token with it; unsharing drops it earlier. Shares live in
 * memory only, so a restart revokes every one. `/mcp/*` skips remote-mode auth, so under
 * `REMOTE=1` the URL works through the tunnel for anyone who has it — that is what makes it
 * useful to a remote agent, and it is why the token is 32 random bytes.
 */

import { ServerEventType } from '@yaar/shared';
import { getSessionHub } from '../../session/session-hub.js';
import type { LiveSession } from '../../session/live-session.js';
import { getAgentId, type AgentRole } from '../../agents/agent-context.js';
import { getActivePool } from '../../handlers/utils.js';

/** Path prefix of a shared window's MCP endpoint. The rest of the path is the token. */
export const EXTERNAL_MCP_PREFIX = '/mcp/x/';

/** The agent id an outside client's calls run under — what history and the timeline show. */
export function externalAgentId(windowKey: string): string {
  return `external:${windowKey}`;
}

export function isExternalAgentId(agentId: string | undefined): boolean {
  return agentId?.startsWith('external:') ?? false;
}

/** The context a shared window's MCP request runs in: its app agent's, under another name. */
export interface ExternalShareContext {
  agentId: string;
  sessionId: LiveSession['sessionId'];
  monitorId?: string;
  windowId: string;
  role: AgentRole;
}

/** Resolve a presented token to the context it grants, or null when it opens nothing. */
export function resolveExternalShare(token: string): ExternalShareContext | null {
  if (!token) return null;
  for (const session of getSessionHub().all()) {
    const key = session.windowState.findExternalShare(token);
    if (!key) continue;
    return {
      agentId: externalAgentId(key),
      sessionId: session.sessionId,
      monitorId: session.windowState.getMonitorForWindow(key),
      windowId: key,
      role: 'app',
    };
  }
  return null;
}

/**
 * Share or unshare a window and tell every tab. Answers the token while shared.
 *
 * Only app windows: the app tools are the whole surface, and a plain window has no app
 * protocol for them to reach.
 */
export function setWindowShared(
  session: LiveSession,
  windowId: string,
  shared: boolean,
): { ok: true; token?: string } | { ok: false; error: string } {
  const win = session.windowState.getWindow(windowId);
  if (!win) return { ok: false, error: `No window ${windowId}.` };
  if (!win.appId) return { ok: false, error: 'Only app windows can be shared.' };

  if (!shared) {
    if (session.windowState.unshareExternally(win.id)) publish(session, win.id, false);
    return { ok: true };
  }
  const wasShared = session.windowState.getExternalShareToken(win.id) !== undefined;
  const token = session.windowState.shareExternally(win.id);
  if (!token) return { ok: false, error: `No window ${windowId}.` };
  if (!wasShared) publish(session, win.id, true);
  return { ok: true, token };
}

function publish(session: LiveSession, windowId: string, shared: boolean): void {
  // Through the session's one gateway, never BroadcastCenter directly (server CLAUDE.md).
  session.broadcast({
    type: ServerEventType.WINDOW_EXTERNAL_SHARE,
    windowId,
    shared,
  });
}

/** A command name safe to quote into a prompt; anything else is summarized. */
const COMMAND_NAME = /^[\w:.-]{1,64}$/;

/**
 * Tell the window's monitor agent that an outside client ran a command, on its next turn.
 *
 * Without this an external command reaches nothing the monitor sees — it emits no OS
 * action and no agent turn — so the agent would find the window changed under it with no
 * idea why. Reads are not noted; they change nothing. Called at every outcome of a
 * protocol command (`handleAppCommand`), a no-op for any caller that is not external.
 *
 * The command name comes from the outside client, so it is quoted only when it looks
 * like one: this line lands verbatim in the monitor agent's prompt.
 */
export function noteExternalCommand(
  windowKey: string,
  monitorId: string | undefined,
  command: string,
  ok: boolean,
): void {
  if (!isExternalAgentId(getAgentId()) || !monitorId) return;
  const pool = getActivePool();
  if (!pool) return;
  const name = COMMAND_NAME.test(command) ? command : 'a command';
  pool
    .timelineFor(monitorId)
    .pushRaw(
      `<external window="${windowKey}">an outside agent the user shared this window with ` +
        `ran ${name}${ok ? '' : ' (failed)'}</external>`,
    );
}
