/**
 * State shared between the copies of one app window.
 *
 * Every connected desktop mounts its own iframe for each window, so a window open while a
 * phone and the companion tab are both attached runs twice. The agent's commands reach
 * exactly one copy — the coordinator pins a single responder, because running a command
 * in both would do its side effects twice. Whatever that command changed in the copy's
 * memory, then, the other copy never sees: devtools recorded the agent's edits in the
 * companion's copy, and the phone's Changes tab stayed empty.
 *
 * This is the fix at the layer that causes it. A value lives here, keyed by the window,
 * and every copy subscribes to it (`createSharedSignal` in the app SDK). The copy that ran
 * the command writes; the others are pinged, read, and render the same thing. Which copy
 * answers stops mattering for anything held this way.
 *
 * Memory only, and scoped to the window's life: it is cleared when the window closes and
 * lost on a server restart. Surviving a restart is what `appStorage` is for.
 */

/** A key an app may name: short, and safe to put in a URI segment unescaped. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Largest single value, as serialized JSON.
 *
 * Sized for the heaviest real tenant — devtools' change history, which holds two copies
 * of every recently edited file. A value is resent whole on every set, so anything near
 * this belongs in storage with a shared pointer to it instead.
 */
export const MAX_SHARED_VALUE_BYTES = 8 * 1024 * 1024;

/** Ceiling on everything one window holds, so a runaway key set cannot grow unbounded. */
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;

interface Entry {
  value: unknown;
  rev: number;
  bytes: number;
}

export interface SharedValue {
  value: unknown;
  /** Monotonic across the server, so a copy can drop a read older than one it has seen. */
  rev: number;
}

export function isValidSharedKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/**
 * The URI a key's change pings are published under.
 *
 * Its own root rather than `yaar://windows/{w}/shared/{key}`: subscriptions match by prefix,
 * so a value under the window's URI would ping every app watching its window for moves
 * each time a copy wrote.
 */
export function sharedValueUri(windowKey: string, key: string): string {
  return `yaar://window-shared/${windowKey}/${key}`;
}

class WindowSharedStore {
  /** sessionId → windowKey → key → entry */
  private sessions = new Map<string, Map<string, Map<string, Entry>>>();
  private rev = 0;

  get(sessionId: string, windowKey: string, key: string): SharedValue | null {
    const entry = this.sessions.get(sessionId)?.get(windowKey)?.get(key);
    return entry ? { value: entry.value, rev: entry.rev } : null;
  }

  /** Store a value and return its rev. Throws when it would exceed a size cap. */
  set(sessionId: string, windowKey: string, key: string, value: unknown, bytes: number): number {
    if (bytes > MAX_SHARED_VALUE_BYTES) {
      throw new Error(
        `Shared value "${key}" is ${bytes} bytes; the limit is ${MAX_SHARED_VALUE_BYTES}.`,
      );
    }
    let windows = this.sessions.get(sessionId);
    if (!windows) {
      windows = new Map();
      this.sessions.set(sessionId, windows);
    }
    let keys = windows.get(windowKey);
    if (!keys) {
      keys = new Map();
      windows.set(windowKey, keys);
    }
    let total = bytes;
    for (const [k, e] of keys) if (k !== key) total += e.bytes;
    if (total > MAX_WINDOW_BYTES) {
      throw new Error(
        `This window's shared values would total ${total} bytes; the limit is ${MAX_WINDOW_BYTES}.`,
      );
    }
    this.rev += 1;
    keys.set(key, { value, rev: this.rev, bytes });
    return this.rev;
  }

  clearWindow(sessionId: string, windowKey: string): void {
    const windows = this.sessions.get(sessionId);
    if (!windows) return;
    windows.delete(windowKey);
    if (windows.size === 0) this.sessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const windowSharedStore = new WindowSharedStore();
