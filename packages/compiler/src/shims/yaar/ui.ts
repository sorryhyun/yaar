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
 * Run an async action; on failure, log it and toast `errMsg(e)`.
 *
 * The most-repeated try/catch in the fleet — ~50 copies, ten of them in one
 * file — is "do the thing, and if it fails tell the user why". Failing silently
 * is the bug that shape exists to prevent, and it is exactly what gets written
 * when the boilerplate is four lines instead of one.
 *
 * ```ts
 * await tryToast(() => deleteRepo(name), { success: 'Deleted' });
 * ```
 *
 * Returns the action's value, or `undefined` if it threw — so a caller that
 * needs to know whether it worked checks the result rather than re-catching.
 * Orthogonal to `withLoading`, which owns a loading flag and knows nothing about
 * toasts; a call site wanting both nests them:
 * `withLoading(setBusy, () => tryToast(...))`.
 */
export async function tryToast<T>(
  fn: () => Promise<T>,
  opts?: { success?: string },
): Promise<T | undefined> {
  try {
    const result = await fn();
    if (opts?.success) showToast(opts.success, 'success');
    return result;
  } catch (e) {
    // Logged as well as toasted: the toast carries the message, the console
    // carries the stack, and the stack is what a devtools session needs.
    console.error('[yaar] tryToast:', e);
    showToast(errMsg(e), 'error');
    return undefined;
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

/** A combo parsed into the shape `shortcutMatches` checks against a KeyboardEvent. */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Parse `"ctrl+s"` / `"alt+arrowup"` / `"escape"` into a `ParsedShortcut`.
 * Returns null for a combo that can never match: an unknown modifier token, a
 * missing key, or a modifier-only combo. Shared by `onShortcut` and
 * `defineApp({ keybindings })` so the two never disagree on combo grammar.
 */
export function parseShortcut(combo: string): ParsedShortcut | null {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  if (!key || key === 'ctrl' || key === 'meta' || key === 'alt' || key === 'shift') return null;
  const mods = new Set(parts);
  for (const part of parts) {
    if (part !== 'ctrl' && part !== 'meta' && part !== 'alt' && part !== 'shift') return null;
  }
  return {
    key,
    ctrl: mods.has('ctrl'),
    meta: mods.has('meta'),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
  };
}

/**
 * True when the event is exactly this combo: the key matches case-insensitively,
 * every required modifier is down, and no unrequired one is (`ctrl` matches both
 * Ctrl and Cmd for cross-platform shortcuts).
 */
export function shortcutMatches(parsed: ParsedShortcut, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== parsed.key) return false;
  if (parsed.ctrl && !e.ctrlKey && !e.metaKey) return false;
  if (parsed.meta && !e.metaKey) return false;
  if (parsed.alt && !e.altKey) return false;
  if (parsed.shift && !e.shiftKey) return false;
  if (!parsed.ctrl && !parsed.meta && (e.ctrlKey || e.metaKey)) return false;
  if (!parsed.alt && e.altKey) return false;
  if (!parsed.shift && e.shiftKey) return false;
  return true;
}

/**
 * True when dispatching a bare (modifier-less) combo would steal a key an
 * editable element is using — arrows move the cursor, letters type. Combos
 * carrying Ctrl/Meta/Alt still fire there, matching how every desktop app
 * treats e.g. Ctrl+S in a text field.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

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
  const parsed = parseShortcut(combo);
  if (!parsed) {
    console.error(`[yaar] onShortcut: unparseable combo "${combo}"`);
    return () => {};
  }

  const listener = (e: KeyboardEvent) => {
    if (!shortcutMatches(parsed, e)) return;
    e.preventDefault();
    handler(e);
  };

  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}

// ── Continuous key state (game input) ────────────────────────────

export interface KeyStateOptions {
  /**
   * Keys whose default browser action is suppressed while the tracker is
   * installed — e.g. `['arrowup', 'arrowdown', ' ']` so a game's movement keys
   * never scroll the window. Matched against `e.key` or `e.code`,
   * case-insensitive.
   */
  preventDefault?: string[];
  /**
   * Skip presses that land in an editable element (input, textarea, select,
   * contenteditable), so typing "w" into a chat box never moves the player.
   * Defaults to true. Releases are always processed.
   */
  ignoreEditable?: boolean;
}

export interface KeyState {
  /**
   * True while `key` is held. Matched against `KeyboardEvent.key`
   * (`'w'`, `'arrowleft'`, `' '`) or `KeyboardEvent.code` (`'KeyW'`,
   * `'Space'` — layout-independent), case-insensitive.
   */
  has(key: string): boolean;
  /** Forget everything currently held (keys stay untracked until re-pressed). */
  clear(): void;
  /** Remove all listeners and clear the held set. */
  dispose(): void;
}

/**
 * Track which keys are held right now — the input half of a game loop.
 *
 * Declarative `keybindings` and `onShortcut` fire discrete actions on keydown;
 * continuous movement instead samples held state every frame:
 *
 * ```ts
 * const keys = createKeyState({ preventDefault: ['arrowup', 'arrowdown', ' '] });
 * function frame(dt: number) {
 *   if (keys.has('w') || keys.has('arrowup')) player.y -= speed * dt;
 *   if (keys.has('d') || keys.has('arrowright')) player.x += speed * dt;
 * }
 * ```
 *
 * Gets the fiddly parts right by default: OS auto-repeat is ignored, held state
 * clears on window blur and tab-hide (alt-tabbing with `w` held must not leave
 * the player running forever), and releases are keyed by `e.code` so a modifier
 * changing `e.key` mid-hold (Alt+W reports `'∑'` on macOS) can never leave a
 * stuck key. `has('KeyW')` matches the physical key on any layout; `has('w')`
 * matches what the layout typed at press time.
 */
export function createKeyState(options: KeyStateOptions = {}): KeyState {
  const ignoreEditable = options.ignoreEditable !== false;
  const prevent = new Set((options.preventDefault ?? []).map((k) => k.toLowerCase()));
  /** lowercased `e.code` → lowercased `e.key` recorded at press time */
  const held = new Map<string, string>();

  const codeOf = (e: KeyboardEvent) => (e.code || e.key).toLowerCase();

  const onKeyDown = (e: KeyboardEvent) => {
    if (prevent.has(e.key.toLowerCase()) || prevent.has(codeOf(e))) e.preventDefault();
    if (e.repeat) return;
    if (ignoreEditable && isEditableTarget(e.target)) return;
    held.set(codeOf(e), e.key.toLowerCase());
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(codeOf(e));
  };
  const clear = () => held.clear();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') clear();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    has(key: string): boolean {
      const q = key.toLowerCase();
      if (held.has(q)) return true;
      for (const pressed of held.values()) if (pressed === q) return true;
      return false;
    },
    clear,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibility);
      clear();
    },
  };
}
