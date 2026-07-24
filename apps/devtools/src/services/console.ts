export {};
import { invoke } from '@bundled/yaar';
import { consoleLogs, setConsoleLogs, previewWindowId, type ConsoleEntry } from '../core';

// The preview console buffer: local mutations plus the poll that keeps the
// panel live while a preview window is open.

export function clearConsoleLogs(): void {
  setConsoleLogs([]);
}

export function addConsoleEntry(entry: ConsoleEntry): void {
  setConsoleLogs((prev) => {
    const next = [...prev, entry];
    return next.length > 200 ? next.slice(-200) : next;
  });
}

/**
 * Pull the preview app's console buffer once and update the display signal.
 * The preview runs as its own registered window, so we read its captured
 * console over the app protocol (built-in `__console` state key).
 */
export async function refreshConsole(): Promise<void> {
  const wid = previewWindowId();
  if (!wid) return;
  try {
    const entries = await invoke<ConsoleEntry[]>(`yaar://windows/${wid}`, {
      action: 'app_query',
      stateKey: '__console',
    });
    if (Array.isArray(entries)) {
      // The preview buffer is a snapshot, while evaluations are initiated by Dev Tools
      // itself. Retain those local audit entries when the next preview poll arrives.
      const evaluations = consoleLogs().filter((entry) => entry.source === 'evaluation');
      const merged = [...entries, ...evaluations]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-200);
      setConsoleLogs(merged);
    }
  } catch {
    /* preview window may be closed — leave the last snapshot in place */
  }
}

let consolePollTimer: ReturnType<typeof setInterval> | null = null;

/** Start polling the preview console so the panel stays live while a preview is open. */
export function startConsolePolling(intervalMs = 1500): void {
  if (consolePollTimer) return;
  consolePollTimer = setInterval(() => {
    void refreshConsole();
  }, intervalMs);
}
