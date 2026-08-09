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
 *
 * `debounceMs` coalesces a burst of sets into one write. Off by default, because
 * for the toggle this primitive usually holds, a set is a click and writing it at
 * once is both correct and free. It is for a signal bound to a **text input**:
 * `onInput` fires per keystroke, and an IME fires it per composition step, so a
 * five-letter name typed in Korean was ~14 writes — 14 disk writes, and 14 lines
 * in the session log, for one field. A pending write is flushed when the page is
 * hidden or unloaded, so closing the window mid-debounce still saves.
 */
export function createPersistedSignal<T>(
  key: string,
  fallback: T,
  options?: {
    label?: string;
    onError?: (message: string, error: unknown) => void;
    revive?: (raw: unknown) => T;
    debounceMs?: number;
  },
): [() => T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = createSignal<T>(fallback);
  const debounceMs = options?.debounceMs ?? 0;
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

  // The serialized value waiting to be written, or null when nothing is owed.
  // Serialized at set time rather than at flush time so a caller that mutates the
  // object it just handed over cannot change what gets persisted.
  let queued: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queued === null) return;
    const body = queued;
    queued = null;
    void appStorage.trySave(key, body, {
      label: options?.label,
      onError: options?.onError,
    });
  };

  // A debounce that can lose the last keystroke is worse than no debounce: the one
  // thing not saved is the most recent thing typed. `pagehide` covers the window
  // being closed; `visibilitychange` covers a hidden tab the browser discards
  // without ever firing it. Both are cheap and idempotent — `flush` no-ops when
  // nothing is queued. Feature-detected because the SDK's own tests run against a
  // hand-rolled DOM rather than a browser.
  if (debounceMs > 0) {
    if (typeof window?.addEventListener === 'function') {
      window.addEventListener('pagehide', flush);
    }
    if (typeof document?.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  const set = (v: T | ((prev: T) => T)) => {
    written = true;
    const next = setValue(v as any);
    queued = JSON.stringify(next);
    if (debounceMs <= 0) {
      flush();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
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
 * Two predicates cover the cases a flag cannot, because they are answered by
 * state the panel does not own:
 *
 *   `canOpen`  — consulted by `open()`. False means the pointer is over the panel
 *                for a reason other than wanting it: a drag that began elsewhere
 *                swept across the rail. The pending fold is still cancelled, so a
 *                drag that ends over the panel does not slam it shut.
 *   `holdOpen` — consulted when the fold actually fires, not when it is armed, so
 *                the answer is read at the moment it matters. True keeps the panel
 *                open without arming anything new; whatever made it true (a focused
 *                input, an open menu) calls `scheduleClose()` again when it ends.
 *
 * Both default to the unguarded behavior, so existing callers are unaffected.
 *
 * Headless: the app owns the markup and pointer wiring; only the state is shared.
 */
export function createCollapsiblePanel(opts?: {
  pinKey?: string; // appStorage key; omit to make pin session-only
  closeDelayMs?: number; // grace period before the fold; default 280
  pinLabel?: string; // toast label on a failed pin persist
  canOpen?: () => boolean; // false → `open()` only cancels the pending fold
  holdOpen?: () => boolean; // true → the fold is skipped when it fires
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
    if (opts?.canOpen && !opts.canOpen()) return;
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
      if (opts?.holdOpen?.()) return;
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
