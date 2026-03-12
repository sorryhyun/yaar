/**
 * NotificationCenter - Displays persistent notifications.
 * Supports optional auto-dismiss via `duration` field.
 */
import { useDesktopStore, selectNotifications } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAutoDismiss } from '@/hooks/useAutoDismiss';
import styles from '@/styles/overlays/NotificationCenter.module.css';

const DEFAULT_DURATION = 8000;

export function NotificationCenter() {
  const notifications = useDesktopStore(useShallow(selectNotifications));
  const dismissNotification = useDesktopStore((s) => s.dismissNotification);

  useAutoDismiss(notifications, dismissNotification, (n) => n.duration || DEFAULT_DURATION);

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
