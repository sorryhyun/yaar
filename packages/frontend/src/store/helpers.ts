/**
 * Helper functions for the desktop store.
 */
import type { DebugSliceState, DesktopStore } from './types';

/** Generate a unique ID with a prefix (e.g. generateId('cli') → 'cli-lx3k9f2-a7b3m'). */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Cap an array to a maximum length, keeping the most recent entries. */
export function capArray<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(-max) : arr;
}

/**
 * Create a monitor-scoped window key for the store.
 * Format: "monitorId/rawWindowId"
 */
export function toWindowKey(monitorId: string, rawId: string): string {
  return `${monitorId}/${rawId}`;
}

/**
 * Resolve a raw windowId to its scoped store key by searching all windows.
 * Returns the raw ID as-is if it already exists as a key, otherwise scans
 * for a key ending with `/rawId`. Falls back to scoping with the given
 * monitorId if no match is found.
 *
 * Used only in iframe-bridge for server messages that may carry raw IDs
 * (app protocol, verb subscriptions, window SDK). Action processing
 * no longer needs this — the server stamps handles before sending.
 */
export function resolveWindowKey(
  windows: Record<string, unknown>,
  rawId: string,
  fallbackMonitorId: string,
): string {
  // 1. Exact match (already scoped or legacy raw key)
  if (windows[rawId]) return rawId;

  // 2. Scan all keys for a suffix match (cross-monitor lookup)
  const suffix = `/${rawId}`;
  for (const key of Object.keys(windows)) {
    if (key.endsWith(suffix)) return key;
  }

  // 3. Fallback: assume the given monitor
  return toWindowKey(fallbackMonitorId, rawId);
}

/**
 * Which monitor a window id belongs to, or `undefined` if it cannot be told.
 *
 * Callers that scope work to one monitor (see `resetDesktop`) hold ids of three shapes:
 * a scoped store key ("1/notes"), a raw id from an iframe or a queued item ("notes"), and
 * an id whose window has already closed. Only the first is self-describing, so the raw
 * forms are resolved through `windows` — and an id that resolves to nothing returns
 * `undefined` rather than a guess, because the callers treat "unknown" as "leave it
 * alone". Guessing the active monitor here would silently drop another monitor's work.
 */
export function monitorOfWindowId(
  windows: Record<string, { monitorId?: string }>,
  windowId: string,
): string | undefined {
  const slashIdx = windowId.indexOf('/');
  if (slashIdx > 0) return windowId.slice(0, slashIdx);

  const own = windows[windowId];
  if (own?.monitorId) return own.monitorId;

  const suffix = `/${windowId}`;
  for (const [key, win] of Object.entries(windows)) {
    if (key.endsWith(suffix)) return win.monitorId ?? key.slice(0, key.indexOf('/'));
  }
  return undefined;
}

/**
 * Get empty content data for a given renderer type.
 */
export function emptyContentByRenderer(renderer: string): unknown {
  switch (renderer) {
    case 'markdown':
    case 'html':
    case 'text':
      return '';
    case 'table':
      return { headers: [], rows: [] };
    case 'component':
      return '';
    case 'iframe':
      return '';
    default:
      return null;
  }
}

/**
 * Add a debug log entry to the state (mutates state via immer).
 */
export function addDebugLogEntry(state: DebugSliceState, type: string, data: unknown): void {
  state.debugLog.push({
    id: generateId('debug'),
    timestamp: Date.now(),
    direction: 'in',
    type,
    data,
  });
  state.debugLog = capArray(state.debugLog, 100);
}

/**
 * Factory for consume-queue actions. Reads all items from an array state key,
 * clears it, and returns them. Avoids unnecessary state updates when empty.
 */
export function createConsumeQueue<K extends keyof DesktopStore>(
  get: () => DesktopStore,
  set: (fn: (state: DesktopStore) => void) => void,
  key: K,
): () => DesktopStore[K] {
  return () => {
    const items = get()[key];
    if (Array.isArray(items) && items.length > 0) {
      set((state) => {
        (state[key] as unknown[]) = [];
      });
    }
    return items;
  };
}
