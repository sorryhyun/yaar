/**
 * Android system notifications for a desktop nobody is looking at.
 *
 * ## The problem
 *
 * On a phone the desktop is a browser tab, and the user switching apps hides it and then
 * freezes it (see `session/client-presence.ts`). The companion tab keeps the *server's*
 * reads answering through that; nothing kept the *user* informed. An agent that finishes
 * the task they left it with, asks permission to run a tool, or asks them a question does
 * all of it on a screen that is not on — and a permission dialog nobody sees is denied at
 * its deadline, so the turn fails for want of a tap the user would have given.
 *
 * ## What this does
 *
 * Watches what the desktop is told (`BroadcastCenter.observe`) and, while no person is
 * looking at the session (`isUserWatching`), mirrors four things into the Android shade:
 *
 * - `notification.show` — an agent's own notification, as itself.
 * - `dialog.confirm` — "approval needed", high priority, because it has a deadline.
 * - `user.prompt.show` — "question", high priority, for the same reason.
 * - a monitor agent's turn completing — the task the user walked away from is done.
 *
 * Tapping any of them opens the desktop. The matching dismiss/close takes the native one
 * down, and the user coming back to the desktop takes all of them down: by then the
 * desktop is showing everything they said, and a shade full of stale copies is noise.
 *
 * Toasts are deliberately not mirrored — a toast is feedback on something the user just
 * did, and there is nothing to act on once they have left.
 */

import {
  MONITOR_ROLE_PREFIX,
  ServerEventType,
  type OSAction,
  type ServerEvent,
} from '@yaar/shared';
import { shellQuote, type TermuxApi } from '@yaar/lib/termux';

/** Everything Android bundles under one YAAR group. */
const GROUP = 'yaar';

/** Longest body a notification carries; the shade truncates anyway, and this is a preview. */
const EXCERPT_CHARS = 240;

export interface NativeNotificationDeps {
  termux: Pick<TermuxApi, 'notify' | 'removeNotification'>;
  isUserWatching: (sessionId: string) => boolean;
  /** The URL a tap opens — the desktop, with whatever token it needs. */
  desktopUrl: () => string;
}

/** A turn's text, flattened for a one-glance preview. */
export function excerpt(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

export class NativeNotificationBridge {
  /** Native ids posted per session, so coming back can take them all down. */
  private posted = new Map<string, Set<string>>();

  constructor(private readonly deps: NativeNotificationDeps) {}

  /** One event the desktop was just sent. */
  handle(sessionId: string, event: ServerEvent): void {
    if (event.type === ServerEventType.ACTIONS) {
      for (const action of event.actions) this.handleAction(sessionId, action);
      return;
    }
    if (event.type === ServerEventType.AGENT_RESPONSE) {
      // Two completion events close every turn: the provider's, carrying the text, and
      // AgentSession's unconditional one with none. Only the first says anything. App and
      // sub-agent turns are work the user did not start, so they are not "your task is done".
      if (!event.isComplete || !event.content.trim()) return;
      if (!event.agentId?.startsWith(MONITOR_ROLE_PREFIX)) return;
      this.post(sessionId, `turn-${event.monitorId ?? '0'}`, {
        title: 'YAAR finished',
        content: excerpt(event.content),
      });
    }
  }

  /** Presence changed; if a person is looking again, the shade copies are stale. */
  presenceChanged(sessionId: string): void {
    if (!this.deps.isUserWatching(sessionId)) return;
    const ids = this.posted.get(sessionId);
    if (!ids) return;
    this.posted.delete(sessionId);
    for (const id of ids) void this.deps.termux.removeNotification(id);
  }

  private handleAction(sessionId: string, action: OSAction): void {
    switch (action.type) {
      case 'notification.show':
        this.post(sessionId, `n-${action.id}`, {
          title: action.title,
          content: excerpt(action.body),
        });
        return;
      case 'dialog.confirm':
        this.post(sessionId, `dialog-${action.id}`, {
          title: `Approval needed: ${action.title}`,
          content: excerpt(action.message),
          priority: 'high',
        });
        return;
      case 'user.prompt.show':
        this.post(sessionId, `prompt-${action.id}`, {
          title: `Question: ${action.title}`,
          content: excerpt(action.message),
          priority: 'high',
        });
        return;
      case 'notification.dismiss':
        this.remove(sessionId, `n-${action.id}`);
        return;
      case 'dialog.close':
        this.remove(sessionId, `dialog-${action.id}`);
        return;
      case 'user.prompt.dismiss':
        this.remove(sessionId, `prompt-${action.id}`);
        return;
    }
  }

  private post(
    sessionId: string,
    key: string,
    n: { title: string; content: string; priority?: 'high' },
  ): void {
    if (this.deps.isUserWatching(sessionId)) return;
    const id = nativeId(sessionId, key);
    let ids = this.posted.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.posted.set(sessionId, ids);
    }
    ids.add(id);
    void this.deps.termux.notify({
      id,
      group: GROUP,
      ...n,
      action: `termux-open-url ${shellQuote(this.deps.desktopUrl())}`,
    });
  }

  private remove(sessionId: string, key: string): void {
    const id = nativeId(sessionId, key);
    const ids = this.posted.get(sessionId);
    if (!ids?.delete(id)) return;
    void this.deps.termux.removeNotification(id);
  }
}

/** Namespaced by session so two sessions' "dialog-1" cannot replace each other. */
function nativeId(sessionId: string, key: string): string {
  return `yaar-${sessionId}-${key}`;
}
