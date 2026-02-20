/**
 * ConfirmDialog - Displays confirmation dialogs from the server.
 */
import { useState } from 'react';
import { useDesktopStore, selectDialogs } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import type { DialogModel } from '@/types/state';
import styles from '@/styles/overlays/ConfirmDialog.module.css';

function DialogBox({
  dialog,
  onRespond,
}: {
  dialog: DialogModel;
  onRespond: (
    dialogId: string,
    confirmed: boolean,
    rememberChoice?: 'once' | 'always' | 'deny_always',
  ) => void;
}) {
  const [rememberChoice, setRememberChoice] = useState(false);
  const hasPermissionOptions = dialog.permissionOptions?.showRememberChoice;

  const handleResponse = (confirmed: boolean) => {
    let choice: 'once' | 'always' | 'deny_always' | undefined;
    if (hasPermissionOptions && rememberChoice) {
      choice = confirmed ? 'always' : 'deny_always';
    } else if (hasPermissionOptions) {
      choice = 'once';
    }
    onRespond(dialog.id, confirmed, choice);
  };

  return (
    <div className={styles.dialog}>
      <div className={styles.title}>{dialog.title}</div>
      <div className={styles.message}>{dialog.message}</div>

      {hasPermissionOptions && (
        <label className={styles.rememberChoice}>
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
          />
          <span>Remember my choice</span>
        </label>
      )}

      <div className={styles.buttons}>
        <button className={styles.cancelButton} onClick={() => handleResponse(false)}>
          {dialog.cancelText}
        </button>
        <button className={styles.confirmButton} onClick={() => handleResponse(true)}>
          {dialog.confirmText}
        </button>
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const dialogs = useDesktopStore(useShallow(selectDialogs)) as DialogModel[];
  const respondToDialog = useDesktopStore((s) => s.respondToDialog);
  const { sendDialogFeedback } = useAgentConnection();

  const handleResponse = (
    dialogId: string,
    confirmed: boolean,
    rememberChoice?: 'once' | 'always' | 'deny_always',
  ) => {
    // Send feedback to server
    sendDialogFeedback(dialogId, confirmed, rememberChoice);
    // Remove from store
    respondToDialog(dialogId, confirmed);
  };

  if (dialogs.length === 0) return null;

  return (
    <div className={styles.overlay}>
      {dialogs.map((dialog) => (
        <DialogBox key={dialog.id} dialog={dialog} onRespond={handleResponse} />
      ))}
    </div>
  );
}
