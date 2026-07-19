// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Solid.js reactive primitives layered on app-scoped storage.
 */

// Solid.js primitives — imported from solid-js directly (the Bun plugin resolves to the browser build)
import { createSignal } from 'solid-js';

import { appStorage } from './app-storage.js';

/**
 * Create a Solid.js signal that auto-persists to appStorage.
 * Loads the saved value on creation (async — the signal starts with `fallback`
 * and updates once the stored value is read). Saves automatically on every set.
 * A set that lands before the initial load resolves wins over the stored value.
 *
 * A failed save is reported (logged, and toasted at most once per 5s) rather
 * than dropped: the signal keeps the new value, but it is no longer persisted.
 * Pass `label` to name the data in that toast, or `onError` to replace it.
 */
export function createPersistedSignal<T>(
  key: string,
  fallback: T,
  options?: { label?: string; onError?: (message: string, error: unknown) => void },
): [() => T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = createSignal<T>(fallback);
  let written = false;
  appStorage.readJsonOr<T>(key, fallback).then((stored) => {
    if (!written) setValue(() => stored as any);
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
