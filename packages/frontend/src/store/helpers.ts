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
 * Extract the raw windowId from a (possibly) scoped store key.
 * "0/win-storage" → "win-storage"
 * "win-storage" → "win-storage" (backward compat)
 */
export function getRawWindowId(key: string): string {
  const idx = key.indexOf('/');
  return idx >= 0 ? key.slice(idx + 1) : key;
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
