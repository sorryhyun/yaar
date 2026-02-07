/**
 * NotificationCenter - Displays persistent notifications.
 * Supports optional auto-dismiss via `duration` field.
 */
import { useEffect, useRef } from 'react'
import { useDesktopStore, selectNotifications } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import styles from '@/styles/NotificationCenter.module.css'

export function NotificationCenter() {
  const notifications = useDesktopStore(useShallow(selectNotifications))
  const dismissNotification = useDesktopStore(s => s.dismissNotification)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Auto-dismiss notifications that have a duration
  useEffect(() => {
    for (const notif of notifications) {
      if (notif.duration && !timersRef.current.has(notif.id)) {
        const timer = setTimeout(() => {
          dismissNotification(notif.id)
          timersRef.current.delete(notif.id)
        }, notif.duration)
        timersRef.current.set(notif.id, timer)
      }
    }

    // Clean up timers for removed notifications
    const currentIds = new Set(notifications.map(n => n.id))
    for (const [id, timer] of timersRef.current) {
      if (!currentIds.has(id)) {
        clearTimeout(timer)
        timersRef.current.delete(id)
      }
    }
  }, [notifications, dismissNotification])

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

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
