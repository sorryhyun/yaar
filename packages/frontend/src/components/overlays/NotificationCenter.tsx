/**
 * NotificationCenter - Displays persistent notifications.
 * Supports optional auto-dismiss via `duration` field.
 */
import { useDesktopStore, selectNotifications } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAutoDismiss } from '@/hooks/useAutoDismiss';
import styles from '@/styles/overlays/NotificationCenter.module.css';

export function NotificationCenter() {
  const notifications = useDesktopStore(useShallow(selectNotifications));
  const dismissNotification = useDesktopStore((s) => s.dismissNotification);

  // Notifications persist until the user dismisses them via the × button.
  // They only auto-dismiss when the sender sets an explicit positive `duration`
  // (e.g. yaar://user notify with duration). Agent → user direct messages carry
  // no duration, so they stay put until manually closed.
  useAutoDismiss(notifications, dismissNotification, (n) => n.duration ?? 0);

  if (notifications.length === 0) return null;

  return (
    <div className={styles.container}>
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
