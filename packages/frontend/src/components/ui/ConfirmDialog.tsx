/**
 * ConfirmDialog - Displays confirmation dialogs from the server.
 */
import { useDesktopStore, selectDialogs } from '@/store'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import type { DialogModel } from '@/types/state'
import styles from '@/styles/ConfirmDialog.module.css'

export function ConfirmDialog() {
  const dialogs = useDesktopStore(selectDialogs) as DialogModel[]
  const respondToDialog = useDesktopStore(s => s.respondToDialog)
  const { sendDialogFeedback } = useAgentConnection()

  const handleResponse = (dialogId: string, confirmed: boolean) => {
    // Send feedback to server
    sendDialogFeedback(dialogId, confirmed)
    // Remove from store
    respondToDialog(dialogId, confirmed)
  }

  if (dialogs.length === 0) return null

  return (
    <div className={styles.overlay}>
      {dialogs.map(dialog => (
        <div key={dialog.id} className={styles.dialog}>
          <div className={styles.title}>{dialog.title}</div>
          <div className={styles.message}>{dialog.message}</div>
          <div className={styles.buttons}>
            <button
              className={styles.cancelButton}
              onClick={() => handleResponse(dialog.id, false)}
            >
              {dialog.cancelText}
            </button>
            <button
              className={styles.confirmButton}
              onClick={() => handleResponse(dialog.id, true)}
            >
              {dialog.confirmText}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
