/**
 * ToastContainer - Displays toast notifications.
 */
import { useEffect } from 'react'
import { useDesktopStore, selectToasts } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import styles from '@/styles/ToastContainer.module.css'

interface ToastContainerProps {
  onToastAction?: (toastId: string, eventId: string) => void
}

export function ToastContainer({ onToastAction }: ToastContainerProps) {
  const toasts = useDesktopStore(useShallow(selectToasts))
  const dismissToast = useDesktopStore(s => s.dismissToast)

  // Auto-dismiss toasts (per-toast duration or default 5s)
  useEffect(() => {
    const timers = toasts.map(toast => {
      return setTimeout(() => {
        dismissToast(toast.id)
      }, toast.duration ?? 5000)
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
          <span className={styles.message}>{toast.message}</span>
          {toast.action && (
            <button
              className={styles.actionButton}
              onClick={(e) => {
                e.stopPropagation()
                onToastAction?.(toast.id, toast.action!.eventId)
                dismissToast(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
