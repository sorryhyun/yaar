export {};
import { createSignal } from '@bundled/solid-js';
import { createPersistedSignal } from '@bundled/yaar';

const KEY = 'layout.json';

/** Wide enough that file names in the overlay are actually readable. */
export const DEFAULT_PANEL_WIDTH = 340;
export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_RATIO = 0.7;

interface LayoutPrefs {
  panelWidth: number;
}

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
 * Validate the loaded value. Deliberately does not clamp: what is stored is the
 * user's preference, and the clamp belongs on the read (see panelWidth) so a
 * temporarily narrow window can't shrink it for good.
 */
function reviveLayout(raw: unknown): LayoutPrefs {
  const stored = raw as Partial<LayoutPrefs> | null | undefined;
  const width =
    typeof stored?.panelWidth === 'number' && Number.isFinite(stored.panelWidth)
      ? stored.panelWidth
      : DEFAULT_PANEL_WIDTH;
  return { panelWidth: width };
}

const [layout, setLayout] = createPersistedSignal<LayoutPrefs>(
  KEY,
  { panelWidth: DEFAULT_PANEL_WIDTH },
  { label: 'layout settings', revive: reviveLayout },
);

/** The stored preference, clamped to what the current window can actually show. */
export const panelWidth = () => clampPanelWidth(layout().panelWidth);

export function setPanelWidth(w: number) {
  setLayout({ panelWidth: clampPanelWidth(w) });
}

export function resetPanelWidth() {
  setPanelWidth(DEFAULT_PANEL_WIDTH);
}

/**
 * Re-clamp after the window resizes, so the panel can't exceed 70% of it.
 *
 * This only refreshes the viewport signal — the stored preference is left alone,
 * so widening the window again restores the width the user actually chose. It
 * also has to stay write-free for a second reason: a resize can land before the
 * async load does, and a write here would supersede the value still in flight.
 */
export function reclampPanelWidth() {
  setViewportWidth(window.innerWidth);
}
