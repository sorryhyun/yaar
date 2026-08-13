/**
 * Taskbar - Every window on this monitor, as a row of tabs under the input bar.
 *
 * It showed only *minimized* windows before, which made the row a place windows went
 * rather than a way to reach them: an open window had no tab, so a window buried under
 * three others could only be dug out by hand, and the row said nothing about what the
 * desktop was holding. A minimized window is still distinguishable — it is dimmed, and its
 * tab is the way back — but so is the focused one, and so is everything in between.
 *
 * Monitor tabs and the "new monitor" button used to live here; they now render
 * inside the command palette's input bar (see MonitorTabs).
 */
import { useDesktopStore, selectTaskbarWindows } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import styles from '@/styles/taskbar/Taskbar.module.css';

const rendererIcons: Record<string, string> = {
  markdown: '\u{1F4C4}',
  html: '\u{1F310}',
  iframe: '\u{1F310}',
  table: '\u{1F4CA}',
  text: '\u{1F4DD}',
  component: '\u{1F9E9}',
};

export function Taskbar() {
  const windows = useDesktopStore(useShallow(selectTaskbarWindows));
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);
  const userFocusWindow = useDesktopStore((s) => s.userFocusWindow);
  const userMinimizeWindow = useDesktopStore((s) => s.userMinimizeWindow);
  const userCloseWindow = useDesktopStore((s) => s.userCloseWindow);

  /**
   * The one behaviour every taskbar has: a tab raises its window, and the tab of the
   * window already in front puts it away. `userFocusWindow` un-minimizes on its own, so
   * the buried case and the put-away case are the same click.
   */
  const toggle = (windowId: string, isActive: boolean) => {
    if (isActive) userMinimizeWindow(windowId);
    else userFocusWindow(windowId);
  };

  return (
    <div className={styles.taskbar}>
      {windows.length > 0 && (
        <div className={styles.windowTabs}>
          {windows.map((win) => {
            const isActive = !win.minimized && win.id === focusedWindowId;
            return (
              <button
                key={win.id}
                className={styles.tab}
                data-active={isActive || undefined}
                data-minimized={win.minimized || undefined}
                aria-pressed={isActive}
                onClick={() => toggle(win.id, isActive)}
                title={win.title}
              >
                <span className={styles.tabIcon}>
                  {rendererIcons[win.content.renderer] ?? '\u{1F4C4}'}
                </span>
                <span className={styles.tabTitle}>{win.title}</span>
                <span
                  className={styles.tabClose}
                  role="button"
                  aria-label={`Close ${win.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    userCloseWindow(win.id);
                  }}
                >
                  &#x2715;
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
