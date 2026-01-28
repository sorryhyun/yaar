/**
 * ToastContainer - Displays toast notifications.
 */
import { useEffect } from 'react'
import { useDesktopStore, selectToasts } from '@/store'
import styles from '@/styles/ToastContainer.module.css'

export function ToastContainer() {
  const toasts = useDesktopStore(selectToasts)
  const dismissToast = useDesktopStore(s => s.dismissToast)

  // Auto-dismiss toasts after 5 seconds
  useEffect(() => {
    const timers = toasts.map(toast => {
      return setTimeout(() => {
        dismissToast(toast.id)
      }, 5000)
    })

    return () => {
      timers.forEach(clearTimeout)
    }
  }, [toasts, dismissToast])

  return (
    <div className={styles.container}>
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={styles.toast}
          data-variant={toast.variant}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
