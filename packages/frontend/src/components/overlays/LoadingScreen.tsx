import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import styles from '@/styles/overlays/LoadingScreen.module.css';

/**
 * How long the first connection may take before the overlay stops pretending it
 * is still loading and admits the server is not answering.
 */
const STALLED_AFTER_MS = 8000;

/**
 * Full-screen loading overlay shown before the first WebSocket connection is established.
 * Fades out and unmounts once connected.
 *
 * If that first connection never lands, the overlay used to sit there forever — its
 * only exit was `connectionStatus === 'connected'`, so an unreachable server looked
 * exactly like a slow one, permanently. After STALLED_AFTER_MS it switches to a
 * stalled view that names the problem and offers Retry, while the backoff keeps
 * retrying on its own in the background.
 */
export function LoadingScreen() {
  const { t } = useTranslation();
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const connectionError = useDesktopStore((s) => s.connectionError);
  const { retryConnection } = useAgentConnection();
  const [fading, setFading] = useState(false);
  const [visible, setVisible] = useState(true);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (connectionStatus === 'connected' && !fading) {
      setFading(true);
      const timer = setTimeout(() => setVisible(false), 500);
      return () => clearTimeout(timer);
    }
  }, [connectionStatus, fading]);

  useEffect(() => {
    if (connectionStatus === 'connected') return;
    const timer = setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connectionStatus]);

  if (!visible) return null;

  return (
    <div className={styles.overlay} data-fading={fading || undefined}>
      <div className={styles.title}>{t('loading.title')}</div>
      {stalled && connectionStatus !== 'connected' ? (
        <>
          <div className={styles.status}>{t('loading.stalled')}</div>
          {connectionError && <div className={styles.detail}>{connectionError}</div>}
          <button className={styles.retryButton} onClick={retryConnection}>
            {t('loading.retry')}
          </button>
        </>
      ) : (
        <div className={styles.status}>{t('loading.status')}</div>
      )}
    </div>
  );
}
