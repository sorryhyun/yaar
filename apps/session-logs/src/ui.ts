import { createSignal } from '@bundled/solid-js';
import { createPersistedSignal } from '@bundled/yaar';

/**
 * Layout / chrome state. Kept out of `store.ts` (which holds session *data*)
 * so the persisted view preferences have one obvious home.
 */

/** Wide-layout preference: is the session sidebar pinned open? Persisted. */
export const [sidebarPinned, setSidebarPinned] = createPersistedSignal(
  'prefs/sidebar-pinned.json',
  true,
  { label: 'sidebar preference', revive: (raw) => raw !== false },
);

/** Show the full metadata card grid instead of the one-line strip. Persisted. */
export const [metaExpanded, setMetaExpanded] = createPersistedSignal(
  'prefs/meta-expanded.json',
  false,
  { label: 'metadata preference', revive: (raw) => raw === true },
);

/** Viewport is too narrow to afford a permanent sidebar (~600px). */
const [narrowSig, setNarrow] = createSignal(false);
export const narrow = narrowSig;

/** Narrow layout only: the sidebar is an overlay drawer, closed by default. */
const [drawerSig, setDrawer] = createSignal(false);
export const drawerOpen = drawerSig;
export const closeDrawer = () => setDrawer(false);

/**
 * Track the narrow breakpoint. Returns a cleanup thunk — hand it to onCleanup.
 * Dropping out of narrow mode also drops the transient drawer, so the pinned
 * preference is what decides the wide layout.
 */
export function watchViewport(): () => void {
  const mq = window.matchMedia('(max-width: 600px)');
  const apply = () => {
    setNarrow(mq.matches);
    setDrawer(false);
  };
  apply();
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
}

export const sidebarVisible = () => (narrow() ? drawerOpen() : sidebarPinned());

/** One button, two meanings: toggle the drawer when narrow, the pin when wide. */
export function toggleSidebar() {
  if (narrow()) setDrawer((v) => !v);
  else setSidebarPinned((v) => !v);
}

export function toggleMeta() {
  setMetaExpanded((v) => !v);
}
