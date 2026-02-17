/**
 * RestorePromptBanner - Banner prompting user to restore previous session.
 */
import { useState, useCallback } from 'react';
import { useDesktopStore } from '@/store';
import type { OSAction } from '@yaar/shared';
import { apiFetch } from '@/lib/api';
import styles from '@/styles/ui/RestorePromptBanner.module.css';

export function RestorePromptBanner() {
  const restorePrompt = useDesktopStore((state) => state.restorePrompt);
  const dismissRestorePrompt = useDesktopStore((state) => state.dismissRestorePrompt);
  const applyActions = useDesktopStore((state) => state.applyActions);
  const clearDesktop = useDesktopStore((state) => state.clearDesktop);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    if (!restorePrompt) return;

    try {
      setRestoring(true);
      const response = await apiFetch(`/api/sessions/${restorePrompt.sessionId}/restore`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Failed to restore session');
      }
      const data = await response.json();
      if (data.actions && Array.isArray(data.actions)) {
        clearDesktop();
        applyActions(data.actions as OSAction[]);
      }
      dismissRestorePrompt();
    } catch (err) {
      console.error('Failed to restore session:', err);
      dismissRestorePrompt();
    } finally {
      setRestoring(false);
    }
  }, [restorePrompt, applyActions, clearDesktop, dismissRestorePrompt]);

  if (!restorePrompt) return null;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className={styles.banner}>
      <span className={styles.message}>
        Restore your previous session from {formatDate(restorePrompt.sessionDate)}?
      </span>
      <div className={styles.actions}>
        <button className={styles.restoreButton} onClick={handleRestore} disabled={restoring}>
          {restoring ? 'Restoring...' : 'Restore'}
        </button>
        <button
          className={styles.dismissButton}
          onClick={dismissRestorePrompt}
          disabled={restoring}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
