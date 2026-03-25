/**
 * Reactive store for the Browser app.
 * Parses URL query params, declares all signals, and provides
 * pure state-mutator helpers (no DOM or network dependencies).
 */
import { createSignal, createMemo } from '@bundled/solid-js';

// ── URL param parsing ─────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);

export const initialBrowserId = params.get('browserId') || '0';

const rawInitialUrl = params.get('url') || '';
let parsedInitialUrl = 'about:blank';
if (rawInitialUrl) {
  try {
    const parsed = new URL(rawInitialUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsedInitialUrl = parsed.toString();
    }
  } catch {
    // ignore invalid url and keep about:blank
  }
}
export { parsedInitialUrl };

// ── Signals ───────────────────────────────────────────────────────────

export const [activeBrowserId, setActiveBrowserId] = createSignal(initialBrowserId);
export const [currentUrl, setCurrentUrl] = createSignal(parsedInitialUrl);
export const [pageTitle, setPageTitle] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [showScreenshot, setShowScreenshot] = createSignal(false);
export const [placeholderText, setPlaceholderText] = createSignal('Waiting for navigation...');

// ── Derived state ─────────────────────────────────────────────────────

export interface LockState { cls: string; icon: string; }

export function getLockState(url: string): LockState {
  if (url === 'about:blank') return { cls: 'lock hidden', icon: '' };
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      ? { cls: 'lock', icon: '\uD83D\uDD12' }  // 🔒
      : { cls: 'lock insecure', icon: '\uD83D\uDD13' };  // 🔓
  } catch {
    return { cls: 'lock insecure', icon: '\uD83D\uDD13' };  // 🔓
  }
}

/**
 * Merged lock state: parses the URL exactly once per render tick.
 * Using createMemo avoids parsing the URL twice (previously separate
 * lockClass / lockIcon signals).
 */
export const lock = createMemo<LockState>(() => getLockState(currentUrl()));

// ── Pure state mutators ───────────────────────────────────────────────

export function updateUrlBar(url: string, title?: string): void {
  setCurrentUrl(url);
  if (title !== undefined) setPageTitle(title);
}

/**
 * Shared reset helper used by clearDisplay() and attach().
 * Hides the screenshot, clears URL/title, and sets a placeholder message.
 */
export function resetDisplay(placeholder: string): void {
  setShowScreenshot(false);
  setCurrentUrl('about:blank');
  setPageTitle('');
  setPlaceholderText(placeholder);
}

export function clearDisplay(): void {
  resetDisplay('Browser closed.');
}
