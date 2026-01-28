/**
 * NotificationCenter - Displays persistent notifications.
 */
import { useDesktopStore, selectNotifications } from '@/store'
import styles from '@/styles/NotificationCenter.module.css'

export function NotificationCenter() {
  const notifications = useDesktopStore(selectNotifications)
  const dismissNotification = useDesktopStore(s => s.dismissNotification)

  if (notifications.length === 0) return null

  return (
    <div className={styles.container}>
      {notifications.map(notif => (
        <div key={notif.id} className={styles.notification}>
          <div className={styles.header}>
            <span className={styles.title}>{notif.title}</span>
            <button
              className={styles.dismiss}
              onClick={() => dismissNotification(notif.id)}
            >
              ×
            </button>
          </div>
          <div className={styles.body}>{notif.body}</div>
        </div>
      ))}
    </div>
  )
}
