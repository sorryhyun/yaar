/**
 * NotificationShade - the phone's status and notifications, behind a pull-down.
 *
 * On a desktop notifications stack in the top-right corner, where there is room for them,
 * and the connection and agent readings sit in a pill at the top. On a phone that corner
 * is a card's title bar and that pill is a permanent strip of a small screen, so both
 * live here instead: pulled down from the top edge (`PhoneGestures`), or opened by the
 * badge that appears while notifications are waiting — the badge is what keeps a hidden
 * notification from being a lost one.
 *
 * The shade is therefore never empty. It used to close itself the moment the last
 * notification went, which made a pull-down on a quiet session look like a gesture that
 * did not work; now the pull always lands on something, because the status above the
 * list is there whether or not anything has been notified.
 *
 * Auto-dismiss still belongs to `NotificationCenter`, which owns the timers whichever
 * form factor is on screen. This component only renders.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { useDesktopStore, selectNotifications } from '@/store';
import { AgentRoster, ConnectionStatus } from '../desktop/AgentStatus';
import { swipeDirection } from '@/lib/gestures';
import styles from '@/styles/overlays/NotificationShade.module.css';

interface NotificationShadeProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

export function NotificationShade({ interrupt, interruptAgent }: NotificationShadeProps) {
  const { t } = useTranslation();
  const notifications = useDesktopStore(useShallow(selectNotifications));
  const dismissNotification = useDesktopStore((s) => s.dismissNotification);
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const open = useDesktopStore((s) => s.notificationShadeOpen);
  const setOpen = useDesktopStore((s) => s.setNotificationShadeOpen);

  // An open shade covers the screen, so Escape has to reach it even when the focus is
  // somewhere else — a hardware keyboard on a tablet, or a phone's own.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // Push the shade back up the way it came. The grip sits at the bottom edge of the
  // sheet, which is where the finger that pulled it down ended up.
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const onGripTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    dragStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);

  const onGripTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = dragStart.current;
      dragStart.current = null;
      const touch = e.changedTouches[0];
      if (!start || !touch) return;
      if (swipeDirection(touch.clientX - start.x, touch.clientY - start.y) !== 'up') return;
      // The drag decided; stop the browser following it with a click that would ask again.
      e.preventDefault();
      setOpen(false);
    },
    [setOpen],
  );

  if (!isMobile) return null;

  if (!open) {
    if (notifications.length === 0) return null;
    return (
      <button
        className={styles.badge}
        onClick={() => setOpen(true)}
        aria-label={t('notifications.open', { count: notifications.length })}
      >
        <span aria-hidden="true">&#9679;</span>
        {notifications.length}
      </button>
    );
  }

  return (
    <>
      <div className={styles.backdrop} onClick={() => setOpen(false)} />
      <div className={styles.shade} role="dialog" aria-label={t('status.title')}>
        {/* What the desktop keeps in its status pill all session. */}
        <div className={styles.status}>
          <ConnectionStatus />
        </div>
        <div className={styles.roster}>
          <AgentRoster interrupt={interrupt} interruptAgent={interruptAgent} />
        </div>

        <div className={styles.header}>
          <span className={styles.heading}>{t('notifications.title')}</span>
          {notifications.length > 0 && (
            <button
              className={styles.clearAll}
              onClick={() => notifications.forEach((n) => dismissNotification(n.id))}
            >
              {t('notifications.clearAll')}
            </button>
          )}
        </div>

        <div className={styles.list}>
          {notifications.length === 0 ? (
            <div className={styles.empty}>{t('notifications.empty')}</div>
          ) : (
            notifications.map((notif) => (
              <div key={notif.id} className={styles.notification}>
                <div className={styles.notificationHeader}>
                  <span className={styles.title}>{notif.title}</span>
                  <button
                    className={styles.dismiss}
                    onClick={() => dismissNotification(notif.id)}
                    aria-label={t('notifications.dismiss')}
                  >
                    &times;
                  </button>
                </div>
                <div className={styles.body}>{notif.body}</div>
              </div>
            ))
          )}
        </div>

        <button
          className={styles.closeHandle}
          onClick={() => setOpen(false)}
          onTouchStart={onGripTouchStart}
          onTouchEnd={onGripTouchEnd}
          aria-label={t('notifications.close')}
        >
          <span className={styles.grip} />
        </button>
      </div>
    </>
  );
}
