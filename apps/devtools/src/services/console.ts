export {};
import { errMsg, invoke } from '@bundled/yaar';
import {
  consoleLogs,
  setConsoleLogs,
  previewWindowId,
  onRemoteBuild,
  type ConsoleEntry,
} from '../core';
import { collapseAuditText } from '../lib/preview-shape';

// The preview console buffer: local mutations plus the poll that keeps the
// panel live while a preview window is open.

export function clearConsoleLogs(): void {
  setConsoleLogs([]);
}

// A compile in another copy of this window clears the buffer here too, as `compile`
// does in its own copy. The poll alone would not: it keeps evaluation lines across
// snapshots, so the previous build's evaluations would outlive it in this copy only.
onRemoteBuild(() => setConsoleLogs([]));

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

export interface ConsoleReadOptions {
  /** Keep only these levels (log, info, warn, error). */
  levels?: string[];
  /** `app`: the preview's own output; `devtools`: the eval/fault audit; default both. */
  source?: 'app' | 'devtools' | 'all';
  /** Newest entries kept, default and max 200. */
  limit?: number;
  /** Audit entries whole instead of collapsed to one line. */
  full?: boolean;
}

export type ConsoleReadEntry = ConsoleEntry & { collapsed?: true };

export interface ConsoleRead {
  connected: boolean;
  reason?: string;
  windowId?: string;
  logs: ConsoleReadEntry[];
  /** Entries the filters dropped, so a short list is not mistaken for a quiet app. */
  filtered?: number;
}

/**
 * The preview's console buffer merged with Dev Tools' own audit entries, for the agent.
 *
 * Pulled live from the preview window — its console-capture buffer is the source of truth
 * for what the app logged; the local signal only lags it by a poll — with the audit entries
 * (`previewEval` inputs and results, fault-rule changes) merged in by time, since those run
 * from here and never reach the preview's buffer. Audit entries come back collapsed to one
 * line unless `full`: they replay calls the reader made itself, results included, and
 * returned whole they crowded out what the app logged.
 *
 * Each failure ("no preview open", "preview unreachable") gets its own reason, distinct
 * from an app that logged nothing.
 */
export async function readPreviewConsole(opts: ConsoleReadOptions = {}): Promise<ConsoleRead> {
  const wid = previewWindowId();
  if (!wid) {
    return {
      connected: false,
      reason: 'No preview window is open. Run the preview command first.',
      logs: [],
    };
  }
  let head: Pick<ConsoleRead, 'connected' | 'reason' | 'windowId'>;
  let all: ConsoleEntry[];
  try {
    const entries = await invoke<unknown>(`yaar://windows/${wid}`, {
      action: 'app_query',
      stateKey: '__console',
    });
    if (Array.isArray(entries)) {
      const evaluations = consoleLogs().filter((entry) => entry.source === 'evaluation');
      all = [...(entries as ConsoleEntry[]), ...evaluations].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      head = { connected: true, windowId: wid };
    } else {
      all = [...consoleLogs()];
      head = {
        connected: false,
        reason: 'Preview window did not return a console buffer.',
        windowId: wid,
      };
    }
  } catch (err) {
    all = [...consoleLogs()];
    head = {
      connected: false,
      reason: `Preview console unreachable: ${errMsg(err)}`,
      windowId: wid,
    };
  }
  const source = opts.source ?? 'all';
  const levels = opts.levels?.length ? new Set(opts.levels) : null;
  const kept = all.filter(
    (e) =>
      (source === 'all' || (source === 'devtools') === (e.source === 'evaluation')) &&
      (!levels || levels.has(e.level)),
  );
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 200)));
  const logs: ConsoleReadEntry[] = kept
    .slice(-limit)
    .map((e) =>
      e.source === 'evaluation' && !opts.full
        ? { ...e, args: [collapseAuditText(e.args.join(' '))], collapsed: true }
        : e,
    );
  const filtered = all.length - kept.length;
  return { ...head, logs, ...(filtered > 0 ? { filtered } : {}) };
}
