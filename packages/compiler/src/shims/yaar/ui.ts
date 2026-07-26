// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Toasts, keyboard shortcuts, and the small app-facing utilities
 * (`errMsg`, `wait`, `withLoading`, `AppCommandError`, `defineAppCommand`).
 */

// ── App Protocol descriptor builders ─────────────────────────────

/**
 * Restore `run`'s parameter typing for a command declared outside the
 * `defineApp({...})` literal.
 *
 * `defineApp` derives each `run`'s parameter from the `params` written *at the
 * call site*, so a command spread in from another module still reaches the
 * manifest intact but loses that inference — silently, with no error, just a
 * free-form bag. Wrapping the descriptor here restores it at the point of
 * declaration, for a Zod `params` (the parsed output type) as well as a JSON
 * Schema literal.
 *
 * Identity at runtime; all the work happens in the type declarations
 * (`bundled-types/index.d.ts`). Keep the call shape literal — a single
 * identifier wrapping the descriptor object. The build-time extractor treats
 * that as transparent (matching this function), but it is a parser, not an
 * evaluator: a computed callee is a hard build error rather than a silently
 * dropped command.
 */
export const defineAppCommand = <T>(descriptor: T): T => descriptor;

// ── Utilities ───────────────────────────────────────────────────

/** Returns a promise that resolves after `ms` milliseconds. */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a human-readable message from any thrown value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Throw from a command handler to signal failure to the agent.
 * The message is delivered as-is — no stack trace, no noise.
 */
export class AppCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCommandError';
  }
}

/**
 * Show a toast notification using the built-in `y-toast` CSS classes.
 * Auto-dismisses after `ms` (default 3000).
 */
export function showToast(
  msg: string,
  type: 'info' | 'success' | 'error' = 'info',
  ms = 3000,
): void {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('y-toast-visible'));
  setTimeout(() => {
    el.classList.remove('y-toast-visible');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ── Async helpers ─────────────────────────────────────────────────

/**
 * Run an async function with loading/error state management.
 * Sets loading to true, runs fn, catches errors via onError, and clears loading in finally.
 */
export async function withLoading<T>(
  setLoading: (v: boolean) => void,
  fn: () => Promise<T>,
  onError?: (msg: string) => void,
): Promise<T | undefined> {
  setLoading(true);
  try {
    return await fn();
  } catch (e) {
    if (onError) onError(errMsg(e));
    else console.error(e);
    return undefined;
  } finally {
    setLoading(false);
  }
}

/**
 * The generation counter that keeps a slow response from overwriting a newer one.
 *
 * Three apps invented this independently (dc-comics `fetchVersion`, github
 * `repoGen`/`stale()`, thesingularity-reader's six inline `version !==` checks),
 * with three different shapes for the same two-line idiom.
 *
 * ```ts
 * const guard = createStaleGuard();
 *
 * async function loadPost(id: string) {
 *   const fresh = guard.begin();          // supersedes anything in flight
 *   const post = await fetchPost(id);
 *   if (!fresh()) return;                 // a newer load started; drop this one
 *   setState('post', post);
 * }
 * ```
 *
 * `begin()` is the common case. `latest()` joins the current generation without
 * superseding it — for a secondary fetch that must be cancelled by the next
 * `begin()` but should not cancel its own siblings. `invalidate()` bumps the
 * generation with no fetch attached, to drop every in-flight response (e.g. the
 * user switched to a different repo).
 */
export function createStaleGuard(): {
  begin(): () => boolean;
  latest(): () => boolean;
  invalidate(): void;
} {
  let generation = 0;
  const at = (gen: number) => () => gen === generation;
  return {
    begin: () => at(++generation),
    latest: () => at(generation),
    invalidate: () => {
      generation++;
    },
  };
}

// ── Keyboard shortcuts ───────────────────────────────────────────

/**
 * Register a keyboard shortcut. Returns a cleanup function.
 *
 * Combo format: modifier keys joined with `+`, e.g. `"ctrl+s"`, `"alt+arrowup"`, `"escape"`.
 * Recognized modifiers: `ctrl`, `meta`, `alt`, `shift`. The non-modifier part is matched
 * against `KeyboardEvent.key` (case-insensitive).
 *
 * `ctrl` matches both Ctrl and Cmd (Meta) for cross-platform shortcuts.
 */
export function onShortcut(combo: string, handler: (e: KeyboardEvent) => void): () => void {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);

  const listener = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== key) return;
    const needCtrl = mods.has('ctrl');
    const needMeta = mods.has('meta');
    const needAlt = mods.has('alt');
    const needShift = mods.has('shift');
    // ctrl matches both ctrlKey and metaKey for cross-platform
    if (needCtrl && !e.ctrlKey && !e.metaKey) return;
    if (needMeta && !e.metaKey) return;
    if (needAlt && !e.altKey) return;
    if (needShift && !e.shiftKey) return;
    // Ensure no unexpected modifiers are pressed (unless required)
    if (!needCtrl && !needMeta && (e.ctrlKey || e.metaKey)) return;
    if (!needAlt && e.altKey) return;
    if (!needShift && e.shiftKey) return;
    e.preventDefault();
    handler(e);
  };

  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
