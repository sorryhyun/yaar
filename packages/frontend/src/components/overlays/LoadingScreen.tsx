import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import styles from '@/styles/overlays/LoadingScreen.module.css';

/**
 * Full-screen loading overlay shown before the first WebSocket connection is established.
 * Fades out and unmounts once connected.
 */
export function LoadingScreen() {
  const { t } = useTranslation();
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const [fading, setFading] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (connectionStatus === 'connected' && !fading) {
      setFading(true);
      const timer = setTimeout(() => setVisible(false), 500);
      return () => clearTimeout(timer);
    }
  }, [connectionStatus, fading]);

  if (!visible) return null;

  return (
    <div className={styles.overlay} data-fading={fading || undefined}>
      <div className={styles.title}>{t('loading.title')}</div>
      <div className={styles.status}>{t('loading.status')}</div>
    </div>
  );
}
