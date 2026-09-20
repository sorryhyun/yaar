/**
 * CliPanel - Tmux-style multi-monitor terminal view.
 * Shows all monitors simultaneously in a split-pane grid layout.
 *
 * Except on a phone, where it shows one: two panes side by side on a 412px screen are
 * two unreadable columns. The one it shows is the monitor the user is on, which is also
 * the monitor the sideways pan that opened the CLI came from (`PhoneGestures`).
 */
import { useDesktopStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { TerminalPane } from './TerminalPane';
import styles from '@/styles/overlays/CliPanel.module.css';

export function CliPanel() {
  const monitors = useDesktopStore(useShallow((s) => s.monitors));
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const cliTarget = useDesktopStore((s) => s.cliTarget);
  const setCliTarget = useDesktopStore((s) => s.setCliTarget);

  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');

  const panes = isMobile ? monitors.filter((m) => m.id === activeMonitorId) : monitors;
  const gridClass =
    panes.length === 1 ? styles.grid1 : panes.length === 2 ? styles.grid2 : styles.grid4;

  return (
    <div className={`${styles.cliPanel} ${gridClass}`}>
      {/* Message-target toggle: route to the monitor agent (sandbox) or the
          session agent ("act as me", drives the user's real browser). */}
      <div
        className={styles.targetToggle}
        title="Where typed messages go. Session acts as you and can drive your real browser."
      >
        <span className={styles.targetLabel}>Send to</span>
        <button
          type="button"
          className={styles.targetButton}
          data-active={cliTarget === 'monitor'}
          onClick={() => setCliTarget('monitor')}
        >
          Monitor
        </button>
        <button
          type="button"
          className={styles.targetButton}
          data-active={cliTarget === 'session'}
          data-session="true"
          onClick={() => setCliTarget('session')}
        >
          Session · act as me
        </button>
      </div>

      {panes.map((monitor) => (
        <TerminalPane
          key={monitor.id}
          monitorId={monitor.id}
          // The pane is numbered by where it sits in the monitor list, not by where it
          // sits in the grid — on a phone those are different and the list is the name.
          index={monitors.indexOf(monitor) + 1}
          isFocused={monitor.id === activeMonitorId}
          onClick={() => switchMonitor(monitor.id)}
        />
      ))}
    </div>
  );
}
