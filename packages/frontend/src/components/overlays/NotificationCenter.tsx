/**
 * NotificationCenter - Displays persistent notifications.
 * Supports optional auto-dismiss via `duration` field.
 *
 * Desktop-only *rendering*. On a phone the same notifications are shown by
 * `NotificationShade`, because a stack in the top-right corner there lands on a card's
 * title bar. The auto-dismiss timers stay here whichever layout is on screen, so there
 * is one owner of when a notification expires rather than one per form factor.
 */
import { useDesktopStore, selectNotifications } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAutoDismiss } from '@/hooks/useAutoDismiss';
import { PromptNotice } from './UserPrompt';
import styles from '@/styles/overlays/NotificationCenter.module.css';

export function NotificationCenter() {
  const notifications = useDesktopStore(useShallow(selectNotifications));
  const dismissNotification = useDesktopStore((s) => s.dismissNotification);
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const hasPrompt = useDesktopStore((s) => Object.keys(s.userPrompts).length > 0);

  // Notifications persist until the user dismisses them via the × button.
  // They only auto-dismiss when the sender sets an explicit positive `duration`
  // (e.g. yaar://user notify with duration). Agent → user direct messages carry
  // no duration, so they stay put until manually closed.
  useAutoDismiss(notifications, dismissNotification, (n) => n.duration ?? 0);

  if (isMobile || (notifications.length === 0 && !hasPrompt)) return null;

  return (
    <div className={styles.container}>
      {/* An agent's question heads the stack: it is the one notice someone is waiting on. */}
      <PromptNotice />
      {notifications.map((notif) => (
        <div key={notif.id} className={styles.notification}>
          <div className={styles.header}>
            <span className={styles.title}>{notif.title}</span>
            <button className={styles.dismiss} onClick={() => dismissNotification(notif.id)}>
              ×
            </button>
          </div>
          <div className={styles.body}>{notif.body}</div>
        </div>
      ))}
    </div>
  );
}
