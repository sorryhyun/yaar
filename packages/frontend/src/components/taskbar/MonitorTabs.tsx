/**
 * MonitorTabs - Monitor switcher + "new monitor" button.
 *
 * Rendered as its own row directly above the command palette's input bar — the
 * mirror of the window taskbar row below it. It used to sit in that
 * bottom row; it is not inside the bar itself.
 */
import { useDesktopStore } from '@/store';
import styles from '@/styles/taskbar/Taskbar.module.css';

export function MonitorTabs() {
  const monitors = useDesktopStore((s) => s.monitors);
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const createMonitor = useDesktopStore((s) => s.createMonitor);
  const removeMonitor = useDesktopStore((s) => s.removeMonitor);

  const showMonitorTabs = monitors.length > 1;
  const showNewMonitor = monitors.length < 4;

  if (!showMonitorTabs && !showNewMonitor) return null;

  return (
    <div className={styles.monitorBar}>
      {showMonitorTabs && (
        <div className={styles.monitorTabs}>
          {monitors.map((m) => (
            <button
              key={m.id}
              className={`${styles.monitorTab} ${m.id === activeMonitorId ? styles.monitorTabActive : ''}`}
              onClick={() => switchMonitor(m.id)}
              title={m.label}
            >
              {m.label}
              <span
                className={styles.monitorClose}
                role="button"
                aria-label={`Close ${m.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeMonitor(m.id);
                }}
              >
                &#x2715;
              </span>
            </button>
          ))}
        </div>
      )}

      {showNewMonitor && (
        <button
          className={styles.newMonitorButton}
          onClick={() => createMonitor()}
          title="Create new monitor"
        >
          +
        </button>
      )}
    </div>
  );
}
