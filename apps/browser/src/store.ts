import { createSignal, createMemo } from '@bundled/solid-js';

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

export const [activeBrowserId, setActiveBrowserId] = createSignal(initialBrowserId);
export const [currentUrl, setCurrentUrl] = createSignal(parsedInitialUrl);
export const [pageTitle, setPageTitle] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [showScreenshot, setShowScreenshot] = createSignal(false);
export const [placeholderText, setPlaceholderText] = createSignal('Waiting for navigation...');

export interface LockState {
  cls: string;
  icon: string;
}

export function getLockState(url: string): LockState {
  if (url === 'about:blank') return { cls: 'lock hidden', icon: '' };
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      ? { cls: 'lock', icon: '🔒' }
      : { cls: 'lock insecure', icon: '🔓' };
  } catch {
    return { cls: 'lock insecure', icon: '🔓' };
  }
}

/** Merged lock state: parses the URL exactly once per render tick via createMemo. */
export const lock = createMemo<LockState>(() => getLockState(currentUrl()));

export function updateUrlBar(url: string, title?: string): void {
  setCurrentUrl(url);
  if (title !== undefined) setPageTitle(title);
}

/** Shared reset helper used by clearDisplay() and attach(). */
export function resetDisplay(placeholder: string): void {
  setShowScreenshot(false);
  setCurrentUrl('about:blank');
  setPageTitle('');
  setPlaceholderText(placeholder);
}

export function clearDisplay(): void {
  resetDisplay('Browser closed.');
}
