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
 * It is also where the phone keeps its two navigation rows — the monitor switcher with
 * its "+" and the window tabs — for the same reason: the bottom edge belongs to the
 * palette's collapsed sheet, and stacking two strips of chips on top of it spent a
 * small screen on chrome that is only wanted between one thing and the next. The shade
 * stays down while they are used: switching monitors and raising windows is done in runs,
 * and a sheet that closed itself on the first tap would have to be pulled back down for
 * the second. It goes away the way it came, by the grip or the backdrop.
 *
 * Auto-dismiss still belongs to `NotificationCenter`, which owns the timers whichever
 * form factor is on screen. This component only renders — with one exception: the sheet
 * is dragged shut by its own grip, and a drag has to be followed rather than waited out,
 * so the grip writes the same `lib/shade-pull` properties the pull-down does. The two
 * halves of the gesture are the same gesture; see that module.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { useDesktopStore, selectNotifications, selectTaskbarWindows } from '@/store';
import { AgentRoster, ConnectionStatus } from '../desktop/AgentStatus';
import { MonitorTabs } from '../taskbar/MonitorTabs';
import { Taskbar } from '../taskbar/Taskbar';
import { shouldCommitDrag } from '@/lib/gestures';
import { clearShadePull, settleShadePull, trackShadePull } from '@/lib/shade-pull';
import styles from '@/styles/overlays/NotificationShade.module.css';

interface NotificationShadeProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

export function NotificationShade({ interrupt, interruptAgent }: NotificationShadeProps) {
  const { t } = useTranslation();
  const notifications = useDesktopStore(useShallow(selectNotifications));
  const windows = useDesktopStore(useShallow(selectTaskbarWindows));
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
  const shadeRef = useRef<HTMLDivElement>(null);
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The drag in progress: where it started, when, and how much of the sheet was on
   * screen then — which is what the pull is measured from, so the sheet keeps sitting
   * under the finger however tall it turned out to be.
   */
  const dragStart = useRef<{ y: number; at: number; shown: number; moved: boolean } | null>(null);

  // The properties are on `<html>` and the shade is not unmounted when it closes, so
  // nothing else will take them away: left at wherever the pull stopped, they would park
  // the *next* shade there — off the top of the screen, if the pull was abandoned. The
  // cleanup cancels a settle the same way, for a shade dismissed out from under one.
  useEffect(() => {
    if (!open || !isMobile) clearShadePull();
    return () => {
      if (settling.current) clearTimeout(settling.current);
      settling.current = null;
    };
  }, [open, isMobile]);

  const onGripTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    dragStart.current = touch
      ? {
          y: touch.clientY,
          at: performance.now(),
          shown: shadeRef.current?.offsetHeight ?? 0,
          moved: false,
        }
      : null;
  }, []);

  const onGripTouchMove = useCallback((e: React.TouchEvent) => {
    const start = dragStart.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    const dy = touch.clientY - start.y;
    // A tap wanders. Nothing moves until the drag has said it is one, or the sheet
    // twitches under every finger that meant to close it with a tap.
    if (!start.moved && Math.abs(dy) < 4) return;
    start.moved = true;
    // No preventDefault: React's touchmove listener is passive, so `touch-action: none`
    // on the grip is what keeps the browser from scrolling the page along with this.
    trackShadePull(start.shown + dy);
  }, []);

  const onGripTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = dragStart.current;
      dragStart.current = null;
      const touch = e.changedTouches[0];
      if (!start || !touch || !start.moved) return;
      // The drag decided; stop the browser following it with a click that would ask again.
      e.preventDefault();
      const dy = touch.clientY - start.y;
      const closing = dy < 0 && shouldCommitDrag(dy, performance.now() - start.at);
      settling.current = settleShadePull(!closing, () => {
        settling.current = null;
        if (closing) setOpen(false);
      });
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
      <div className={styles.shade} ref={shadeRef} role="dialog" aria-label={t('status.title')}>
        {/* What the desktop keeps in its status pill all session. */}
        <div className={styles.status}>
          <ConnectionStatus />
        </div>
        <div className={styles.roster}>
          <AgentRoster interrupt={interrupt} interruptAgent={interruptAgent} />
        </div>

        {/* The two rows the desktop keeps around its input bar. Monitors first: a tap
            there changes which set of windows the row below is listing. */}
        <div className={styles.section}>
          <span className={styles.sectionHeading}>{t('shade.monitors')}</span>
          <MonitorTabs />
        </div>

        <div className={styles.section}>
          <span className={styles.sectionHeading}>{t('shade.windows')}</span>
          {windows.length === 0 ? (
            <div className={styles.sectionEmpty}>{t('shade.noWindows')}</div>
          ) : (
            <Taskbar />
          )}
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
          onTouchMove={onGripTouchMove}
          onTouchEnd={onGripTouchEnd}
          aria-label={t('notifications.close')}
        >
          <span className={styles.grip} />
        </button>
      </div>
    </>
  );
}
