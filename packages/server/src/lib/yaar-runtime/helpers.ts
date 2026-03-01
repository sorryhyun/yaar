/// <reference lib="dom" />

import { signal } from './reactivity.ts';
import type { Signal } from './reactivity.ts';
import type { Child } from './dom.ts';

// ── Conditional & Async ─────────────────────────────────────────────────────

export function show(
  when: () => boolean,
  content: () => Child,
  fallback?: () => Child,
): () => Child {
  return () => (when() ? content() : fallback ? fallback() : null);
}

export interface Resource<T> {
  (): T | undefined;
  loading: Signal<boolean>;
  error: Signal<Error | null>;
  refetch: () => void;
}

export function createResource<T>(
  fetcher: () => Promise<T>,
  options?: { initialValue?: T },
): Resource<T> {
  const data = signal<T | undefined>(options?.initialValue);
  const loading = signal(true);
  const error = signal<Error | null>(null);

  async function load() {
    loading(true);
    error(null);
    try {
      data(await fetcher());
    } catch (e) {
      error(e instanceof Error ? e : new Error(String(e)));
    } finally {
      loading(false);
    }
  }

  load();

  const accessor = (() => data()) as Resource<T>;
  accessor.loading = loading;
  accessor.error = error;
  accessor.refetch = load;
  return accessor;
}
