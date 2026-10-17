/**
 * A tab running an older build than the server now holds.
 *
 * Build output is content-hashed, so a rebuild (or an update) renames every chunk. A tab
 * loaded before it still asks for the old names the first time it lazily imports one —
 * mermaid is the big one — and the server no longer has them. Nothing in the page can
 * fix that; only a reload picks up the new `index.html` and the chunk names it carries.
 * So the failure is recognised here and turned into one toast that offers the reload,
 * rather than an error message about a diagram.
 */
import i18next from 'i18next';
import { useDesktopStore } from '@/store';
import { registerLocalToastAction } from '@/lib/localToastActions';

/**
 * The message each engine gives a dynamic `import()` that could not load its module:
 * Chrome, Firefox, Safari, and the MIME refusal for an HTML page served under a `.js`
 * URL (what the server's SPA fallback used to answer a missing chunk with).
 */
const CHUNK_LOAD_MESSAGES = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Expected a JavaScript module script',
];

export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  if (!message) return false;
  return CHUNK_LOAD_MESSAGES.some((m) => message.includes(m));
}

/** One id, so a burst of failed imports replaces the toast instead of stacking copies. */
const STALE_BUILD_TOAST_ID = 'yaar-stale-build';

/** Offer the reload. Safe to call repeatedly. */
export function announceStaleBuild(): void {
  registerLocalToastAction(STALE_BUILD_TOAST_ID, () => window.location.reload());
  useDesktopStore.getState().applyAction({
    type: 'toast.show',
    id: STALE_BUILD_TOAST_ID,
    message: i18next.t('desktop.newerVersion'),
    variant: 'info',
    action: { label: i18next.t('desktop.reload'), eventId: STALE_BUILD_TOAST_ID },
    // Stays until dismissed or used: the page stays broken until it is reloaded.
    duration: 0,
  });
}

/** For a lazy import nobody caught. Ones with their own handling call `announceStaleBuild`. */
export function installStaleBuildListener(): void {
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason)) announceStaleBuild();
  });
}
