/**
 * ToastContainer - Displays toast notifications.
 */
import { useEffect, useRef } from 'react';
import { useDesktopStore, selectToasts } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import styles from '@/styles/overlays/ToastContainer.module.css';

interface ToastContainerProps {
  onToastAction?: (toastId: string, eventId: string) => void;
}

export function ToastContainer({ onToastAction }: ToastContainerProps) {
  const toasts = useDesktopStore(useShallow(selectToasts));
  const dismissToast = useDesktopStore((s) => s.dismissToast);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Auto-dismiss toasts - only create timers for newly appeared toasts
  useEffect(() => {
    for (const toast of toasts) {
      if (!timersRef.current.has(toast.id)) {
        const timer = setTimeout(() => {
          dismissToast(toast.id);
          timersRef.current.delete(toast.id);
        }, toast.duration ?? 5000);
        timersRef.current.set(toast.id, timer);
      }
    }

    // Clean up timers for removed toasts
    const currentIds = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!currentIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [toasts, dismissToast]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  return (
    <div className={styles.container}>
      {toasts.map((toast) => (
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
                e.stopPropagation();
                onToastAction?.(toast.id, toast.action!.eventId);
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
