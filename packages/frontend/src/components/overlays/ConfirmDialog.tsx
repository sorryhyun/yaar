/**
 * ConfirmDialog - Displays confirmation dialogs from the server.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore, selectDialogs } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import type { DialogModel } from '@/types/state';
import type { CapabilityLine } from '@yaar/shared';
import styles from '@/styles/overlays/ConfirmDialog.module.css';

/**
 * What an app is asking for, one row per grant.
 *
 * The plain-language title leads and the literal grant (`yaar://storage/`) follows it in
 * small monospace — present for anyone who wants the exact answer, but no longer the only
 * thing on offer. A dialog whose whole content was `yaar://…` lines told a non-technical
 * user what was *granted* without ever saying what the app could *do* with it.
 */
function CapabilityList({ lines }: { lines: CapabilityLine[] }) {
  return (
    <ul className={styles.capabilities}>
      {lines.map((line, i) => (
        <li
          key={`${line.title}-${line.raw ?? i}`}
          className={
            line.warn ? `${styles.capability} ${styles.capabilityWarn}` : styles.capability
          }
        >
          <span className={styles.capabilityIcon} aria-hidden="true">
            {line.icon}
          </span>
          <span className={styles.capabilityText}>
            <span className={styles.capabilityTitle}>{line.title}</span>
            {line.detail && <span className={styles.capabilityDetail}>{line.detail}</span>}
            {line.raw && <code className={styles.capabilityRaw}>{line.raw}</code>}
          </span>
        </li>
      ))}
    </ul>
  );
}

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
  const { t } = useTranslation();
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
      <div className={dialog.capabilities?.length ? styles.lead : styles.message}>
        {dialog.message}
      </div>
      {dialog.capabilities && dialog.capabilities.length > 0 && (
        <CapabilityList lines={dialog.capabilities} />
      )}

      {hasPermissionOptions && (
        <label className={styles.rememberChoice}>
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
          />
          <span>{t('confirmDialog.rememberChoice')}</span>
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
