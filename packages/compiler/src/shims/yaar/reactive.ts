// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Solid.js reactive primitives layered on app-scoped storage.
 */

// Solid.js primitives — imported from solid-js directly (the Bun plugin resolves to the browser build)
import { createSignal } from 'solid-js';

import { appStorage } from './app-storage.js';
import { showToast } from './ui.js';

/**
 * Create a Solid.js signal that auto-persists to appStorage.
 * Loads the saved value on creation (async — the signal starts with `fallback`
 * and updates once the stored value is read). Saves automatically on every set.
 * A set that lands before the initial load resolves wins over the stored value.
 *
 * A failed save is reported (logged, and toasted at most once per 5s) rather
 * than dropped: the signal keeps the new value, but it is no longer persisted.
 * Pass `label` to name the data in that toast, or `onError` to replace it.
 *
 * `revive` runs on the loaded value before it reaches the signal — the place to
 * clamp a stale value against the current window, migrate a renamed key, or
 * `z.safeParse` persisted JSON that a previous version wrote in another shape.
 * It runs on the `fallback` too when nothing is stored, so it must be total;
 * if it throws, the fallback is used and the error is logged (never silent).
 */
export function createPersistedSignal<T>(
  key: string,
  fallback: T,
  options?: {
    label?: string;
    onError?: (message: string, error: unknown) => void;
    revive?: (raw: unknown) => T;
  },
): [() => T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = createSignal<T>(fallback);
  let written = false;
  appStorage.readJsonOr<T>(key, fallback).then((stored) => {
    if (written) return;
    let next = stored as any;
    if (options?.revive) {
      try {
        next = options.revive(stored);
      } catch (e) {
        console.error(`[yaar] revive failed for "${key}", using the fallback:`, e);
        next = fallback;
      }
    }
    setValue(() => next);
  });
  const set = (v: T | ((prev: T) => T)) => {
    written = true;
    const next = setValue(v as any);
    void appStorage.trySave(key, JSON.stringify(next), {
      label: options?.label,
      onError: options?.onError,
    });
  };
  return [value, set];
}

/**
 * The hover-expand + pin sidebar/overlay state machine.
 *
 * The panel is visible when pinned, or while the cursor is over it. A grace
 * period before the collapse keeps a brief cursor exit from flickering it shut.
 * Pin state persists to appStorage (opt in with `pinKey`), with a touch-guard so
 * a user toggle that lands before the async load still wins over the stored
 * value. `setResizing(true)` suppresses the auto-close while a width handle is
 * being dragged — the pointer routinely leaves the panel box mid-drag.
 *
 * Headless: the app owns the markup and pointer wiring; only the state is shared.
 */
export function createCollapsiblePanel(opts?: {
  pinKey?: string; // appStorage key; omit to make pin session-only
  closeDelayMs?: number; // grace period before the fold; default 280
  pinLabel?: string; // toast label on a failed pin persist
}): {
  expanded: () => boolean; // pinned() || hovering()
  pinned: () => boolean;
  open(): void; // cancel close + show
  scheduleClose(): void; // arm the delayed fold (no-op while resizing)
  close(): void; // fold now; pinned still wins
  cancelClose(): void; // cancel a pending fold without showing (e.g. onCleanup)
  togglePin(): void;
  setPin(v: boolean): void;
  setResizing(active: boolean): void;
} {
  const closeDelayMs = opts?.closeDelayMs ?? 280;
  const pinKey = opts?.pinKey;

  const [hovering, setHovering] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);

  /** The panel is expanded when pinned, or while the cursor is over it. */
  const expanded = () => pinned() || hovering();

  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelClose = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const open = () => {
    cancelClose();
    setHovering(true);
  };

  let resizing = false;
  const setResizing = (active: boolean) => {
    resizing = active;
    if (active) cancelClose();
  };

  const scheduleClose = () => {
    cancelClose();
    if (resizing) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      setHovering(false);
    }, closeDelayMs);
  };

  const close = () => {
    cancelClose();
    setHovering(false);
  };

  // Pin state is persisted: it is an explicit "keep this open" preference, so it
  // survives a reload. The stored value arrives async, and a user toggle that
  // lands first must win over the late load.
  let pinTouched = false;
  let pinLoaded = false;
  if (pinKey) {
    void appStorage.readJsonOr<boolean>(pinKey, false).then((stored) => {
      if (!pinTouched && stored === true) {
        setPinned(true);
        open();
      }
      pinLoaded = true;
    });
  } else {
    pinLoaded = true;
  }

  const persistPin = () => {
    if (!pinKey) return;
    if (!pinLoaded && !pinTouched) return;
    void appStorage.trySave(pinKey, JSON.stringify(pinned()), { label: opts?.pinLabel });
  };

  const setPin = (v: boolean) => {
    pinTouched = true;
    setPinned(v);
    persistPin();
    // Unpinning also clears the hover flag so the panel folds back; on a device
    // with no mouseleave, leaving it set would make the pin a one-way switch.
    if (v) open();
    else close();
  };

  const togglePin = () => setPin(!pinned());

  return {
    expanded,
    pinned,
    open,
    scheduleClose,
    close,
    cancelClose,
    togglePin,
    setPin,
    setResizing,
  };
}

/**
 * The dirty / debounced-save / save-status lifecycle for an autosaving document.
 *
 * Wraps a save with a debounce, a `dirty`/`saveFailed`/`lastSavedAt` triad, and
 * an **editSeq guard** — a monotonic counter so a save that began before the
 * latest edit does not clear the dirty flag (otherwise the status chip reads
 * "Saved" over unsaved changes). `createPersistedSignal` owns the *storage*;
 * `createAutosave` owns the *save lifecycle and its status*.
 *
 * `save` returns whether the write succeeded; `false` leaves the document dirty.
 * Debounce is a plain timer (the SDK keeps lodash out of its own surface).
 */
export function createAutosave<T = void>(
  save: (value: T) => Promise<boolean>,
  opts?: { debounceMs?: number; onSaved?: () => void },
): {
  markDirty(value: T): void; // bump editSeq, set dirty, schedule debounced save
  flush(withToast?: boolean): Promise<void>; // save now (e.g. Ctrl+S)
  dirty: () => boolean;
  saveFailed: () => boolean;
  lastSavedAt: () => number;
  statusLabel: () => string; // "Saving…" | "Saved 14:22" | "Not saved"
} {
  const debounceMs = opts?.debounceMs ?? 600;

  const [dirty, setDirty] = createSignal(false);
  const [saveFailed, setSaveFailed] = createSignal(false);
  const [lastSavedAt, setLastSavedAt] = createSignal(Date.now());

  // Bumped on every edit, so a save that started before the latest edit does not
  // clear the dirty flag — the chip would then read "Saved" over unsaved changes.
  let editSeq = 0;
  let latest: T;

  const run = async (withToast: boolean): Promise<void> => {
    const savedAt = editSeq;
    const ok = await save(latest);
    setSaveFailed(!ok);
    if (!ok) return;
    if (editSeq === savedAt) setDirty(false);
    setLastSavedAt(Date.now());
    opts?.onSaved?.();
    if (withToast) showToast('Saved', 'success');
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run(false);
    }, debounceMs);
  };

  const markDirty = (value: T) => {
    latest = value;
    editSeq++;
    setDirty(true);
    scheduleSave();
  };

  const flush = async (withToast = false): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await run(withToast);
  };

  const statusLabel = () => {
    if (saveFailed()) return 'Not saved';
    if (dirty()) return 'Saving…';
    const d = new Date(lastSavedAt());
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Saved ${hh}:${mm}`;
  };

  return { markDirty, flush, dirty, saveFailed, lastSavedAt, statusLabel };
}
