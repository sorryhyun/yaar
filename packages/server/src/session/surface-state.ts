/**
 * The live surfaces a session is currently showing, other than its windows.
 *
 * Windows have had a server-side registry all along (`WindowStateRegistry`), which is why
 * they were the only thing a reconnecting client could be told about. Notifications,
 * dialogs, and user prompts were fire-and-forget: broadcast once, remembered only by
 * whichever browser tab happened to be listening at that instant. So a dialog raised while
 * the socket was down was simply never seen — the agent waited out its deadline on a
 * question that never reached anybody — and a notification shown before a reload survived
 * only in the tab that got it.
 *
 * This registry mirrors, on the server, exactly what the client has been told to show. It
 * is fed from `LiveSession.broadcast()`, the single gateway every server→client event goes
 * through, so it cannot drift from what was actually sent: if the client saw it, this saw
 * it too.
 *
 * Toasts are deliberately absent. They expire on their own within seconds and carry no
 * answer anyone is waiting for; re-showing a stale one on reconnect would be noise, not
 * recovery.
 */

import type {
  OSAction,
  DialogConfirmAction,
  NotificationShowAction,
  UserPromptShowAction,
} from '@yaar/shared';

export class SurfaceRegistry {
  private notifications = new Map<string, NotificationShowAction>();
  private dialogs = new Map<string, DialogConfirmAction>();
  private prompts = new Map<string, UserPromptShowAction>();

  /**
   * Mirror one action the client is being told about.
   *
   * Show adds, dismiss/close removes. Anything else — window actions, toasts, app badges —
   * is not a surface this registry owns and is ignored.
   */
  record(action: OSAction): void {
    switch (action.type) {
      case 'notification.show':
        this.notifications.set(action.id, action);
        break;
      case 'notification.dismiss':
        this.notifications.delete(action.id);
        break;
      case 'dialog.confirm':
        this.dialogs.set(action.id, action);
        break;
      case 'dialog.close':
        this.dialogs.delete(action.id);
        break;
      case 'user.prompt.show':
        this.prompts.set(action.id, action);
        break;
      case 'user.prompt.dismiss':
        this.prompts.delete(action.id);
        break;
      default:
        break;
    }
  }

  /**
   * Forget a surface the user has settled: an answered dialog or prompt, or a dismissed
   * notification.
   *
   * These arrive as client events (`DIALOG_FEEDBACK` / `USER_PROMPT_RESPONSE` /
   * a `notification.dismiss` interaction), not as actions, so they never pass through
   * `record()`. Without this, the next snapshot would re-show them — asking a question
   * the user had already settled, or piling dismissed notifications back up on reload.
   */
  answered(id: string): void {
    this.notifications.delete(id);
    this.dialogs.delete(id);
    this.prompts.delete(id);
  }

  /** Re-materialize every live surface as the action that would have created it. */
  snapshot(): OSAction[] {
    return [
      ...this.notifications.values(),
      ...this.dialogs.values(),
      ...this.prompts.values(),
    ] as OSAction[];
  }
}
