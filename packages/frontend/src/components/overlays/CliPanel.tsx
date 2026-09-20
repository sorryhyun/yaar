/**
 * CliPanel - Tmux-style multi-monitor terminal view.
 * Shows all monitors simultaneously in a split-pane grid layout.
 *
 * Except on a phone, where it shows one: two panes side by side on a 412px screen are
 * two unreadable columns. The one it shows is the monitor the user is on, which is also
 * the monitor the sideways pan that opened the CLI came from (`PhoneGestures`).
 *
 * Which left a phone with no way to read another monitor's terminal at all: the grid is
 * the desktop's monitor switcher, and here there is no grid, while the sideways pan out
 * of the CLI goes back to the desktop rather than along the monitor list. So the phone
 * gets the switcher as buttons in a top bar — numbered to match each pane's badge — and
 * the bar is a real row the panel is padded for, rather than more chrome floating over
 * a pane header that has its own buttons in the corner.
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
      {/* `display: contents` on a desktop, where the toggle places itself over the grid;
          a real row on a phone, which has a second control to fit beside it. */}
      <div className={styles.topBar}>
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
            {/* "act as me" is what makes this the privileged door, so it is spelled out
                wherever there is room. On a phone the amber and the tooltip carry it. */}
            Session<span className={styles.targetButtonLong}> · act as me</span>
          </button>
        </div>

        {isMobile && monitors.length > 1 && (
          <div className={styles.monitorSwitch} role="group" aria-label="Monitor">
            {monitors.map((m, i) => (
              <button
                key={m.id}
                type="button"
                className={styles.monitorButton}
                data-active={m.id === activeMonitorId}
                onClick={() => switchMonitor(m.id)}
                title={m.label}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
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
