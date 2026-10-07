export {};
import { createSignal } from '@bundled/solid-js';
import { createPersistedSignal, createSharedSignal, safeParseOr } from '@bundled/yaar';
import { LayoutPrefsSchema } from './schema';

const KEY = 'layout.json';

/** Wide enough that file names in the overlay are actually readable. */
export const DEFAULT_PANEL_WIDTH = 340;
export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_RATIO = 0.7;

export type ViewMode = 'list' | 'grid';
export type SortKey = 'name' | 'modified' | 'size';
export type SortDir = 'asc' | 'desc';
export const SORT_KEYS: readonly SortKey[] = ['name', 'modified', 'size'];

export interface SortPrefs {
  key: SortKey;
  dir: SortDir;
}

interface LayoutPrefs {
  panelWidth: number;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
}

const DEFAULT_PREFS: LayoutPrefs = {
  panelWidth: DEFAULT_PANEL_WIDTH,
  viewMode: 'list',
  sortKey: 'name',
  sortDir: 'asc',
};

// The window width is a signal so the clamp below is reactive: a resize re-runs
// every reader of panelWidth() without writing anything back to storage.
const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);

export function maxPanelWidth(): number {
  return Math.max(MIN_PANEL_WIDTH, Math.round(viewportWidth() * MAX_PANEL_RATIO));
}

export function clampPanelWidth(w: number): number {
  return Math.min(Math.max(Math.round(w), MIN_PANEL_WIDTH), maxPanelWidth());
}

/**
 * Validate the loaded value at the storage trust boundary.
 *
 * Does not clamp: the stored value is the user's preference, and the clamp is applied on
 * read (see panelWidth) so a temporarily narrow window can't shrink it for good.
 *
 * Nothing stored takes the default silently (`createPersistedSignal` also passes its own
 * fallback through `revive`); anything present and malformed, including a literal `null`,
 * is logged by `safeParseOr`.
 */
function reviveLayout(raw: unknown): LayoutPrefs {
  const parsed = safeParseOr(LayoutPrefsSchema, raw, DEFAULT_PREFS, {
    label: 'storage:layout',
  });
  return {
    panelWidth: parsed.panelWidth ?? DEFAULT_PANEL_WIDTH,
    viewMode: parsed.viewMode ?? 'list',
    sortKey: parsed.sortKey ?? DEFAULT_PREFS.sortKey,
    sortDir: parsed.sortDir ?? DEFAULT_PREFS.sortDir,
  };
}

const [layout, setLayout] = createPersistedSignal<LayoutPrefs>(KEY, DEFAULT_PREFS, {
  label: 'layout settings',
  revive: reviveLayout,
});

/** The stored preference, clamped to what the current window can actually show. */
export const panelWidth = () => clampPanelWidth(layout().panelWidth);

export function setPanelWidth(w: number) {
  setLayout({ ...layout(), panelWidth: clampPanelWidth(w) });
}

export const viewMode = () => layout().viewMode;

/**
 * List vs. grid is a content choice ("setViewMode" is a command) rather than a
 * viewport one like panelWidth, so it is also mirrored live via a shared signal —
 * `layout`'s own persistence covers reload, not another copy's screen mid-session.
 * `onRemote` writes straight into the persisted store, never back through
 * `setViewMode`, so adopting a remote value can't re-announce it and ping-pong.
 */
const [, setSharedViewMode] = createSharedSignal<ViewMode>('view-mode', DEFAULT_PREFS.viewMode, {
  onRemote: (mode) => setLayout((prev) => ({ ...prev, viewMode: mode })),
});

export function setViewMode(mode: ViewMode) {
  setLayout({ ...layout(), viewMode: mode });
  setSharedViewMode(mode);
}

export const sortPrefs = (): SortPrefs => ({ key: layout().sortKey, dir: layout().sortDir });

export function isSortKey(v: unknown): v is SortKey {
  return SORT_KEYS.includes(v as SortKey);
}

export function isSortDir(v: unknown): v is SortDir {
  return v === 'asc' || v === 'desc';
}

/**
 * Sort order is a content choice like viewMode, mirrored to other copies the same way.
 * The remote value is checked before it is adopted: a malformed one would otherwise be
 * persisted and fail every later load's schema check.
 */
const [, setSharedSort] = createSharedSignal<SortPrefs>(
  'sort',
  { key: DEFAULT_PREFS.sortKey, dir: DEFAULT_PREFS.sortDir },
  {
    onRemote: (sort) => {
      if (!isSortKey(sort?.key) || !isSortDir(sort?.dir)) return;
      setLayout((prev) => ({ ...prev, sortKey: sort.key, sortDir: sort.dir }));
    },
  },
);

export function setSort(sort: SortPrefs) {
  setLayout({ ...layout(), sortKey: sort.key, sortDir: sort.dir });
  setSharedSort(sort);
}

export function resetPanelWidth() {
  setPanelWidth(DEFAULT_PANEL_WIDTH);
}

/**
 * Re-clamp after the window resizes, so the panel can't exceed 70% of it.
 *
 * Only refreshes the viewport signal and never writes: widening the window again restores
 * the stored width, and a resize can land before the async load, where a write would
 * supersede the value still in flight.
 */
export function reclampPanelWidth() {
  setViewportWidth(window.innerWidth);
}
