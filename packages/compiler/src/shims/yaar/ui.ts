// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Toasts, keyboard shortcuts, and the small app-facing utilities
 * (`errMsg`, `wait`, `withLoading`, `AppCommandError`, `defineCommand`).
 */

// ── App Protocol descriptor builders ─────────────────────────────

/**
 * Identity at runtime — the descriptor is passed to `app.register()` untouched.
 * All the work happens in the type declarations (`bundled-types/index.d.ts`),
 * which infer the handler's parameter type from the `params` JSON Schema.
 *
 * Keep the call shape `defineCommand({ ... })`: the build-time protocol
 * extractor recognises a bare identifier wrapping the descriptor literal, and
 * anything fancier (a computed callee, a spread descriptor) will make it skip
 * the command.
 */
export const defineCommand = <T>(descriptor: T): T => descriptor;

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
