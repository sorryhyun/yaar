export {};
import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';

const KEY = 'layout.json';

/** Wide enough that file names in the overlay are actually readable. */
export const DEFAULT_PANEL_WIDTH = 340;
export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_RATIO = 0.7;

interface LayoutPrefs {
  panelWidth: number;
}

const DEFAULTS: LayoutPrefs = { panelWidth: DEFAULT_PANEL_WIDTH };

const [panelWidth, setPanelWidthRaw] = createSignal(DEFAULT_PANEL_WIDTH);

export { panelWidth };

// The stored value arrives async, and a user change that lands first must win
// over the late load.
let userTouched = false;
let loaded = false;

export function maxPanelWidth(): number {
  return Math.max(MIN_PANEL_WIDTH, Math.round(window.innerWidth * MAX_PANEL_RATIO));
}

export function clampPanelWidth(w: number): number {
  return Math.min(Math.max(Math.round(w), MIN_PANEL_WIDTH), maxPanelWidth());
}

void appStorage.readJsonOr<Partial<LayoutPrefs>>(KEY, DEFAULTS).then((stored) => {
  if (!userTouched && stored && typeof stored === 'object') {
    const raw = typeof stored.panelWidth === 'number' ? stored.panelWidth : null;
    if (raw !== null && Number.isFinite(raw)) {
      setPanelWidthRaw(clampPanelWidth(raw));
    }
  }
  loaded = true;
});

function persist() {
  if (!loaded && !userTouched) return;
  void appStorage.trySave(KEY, JSON.stringify({ panelWidth: panelWidth() }), {
    label: 'layout settings',
  });
}

export function setPanelWidth(w: number) {
  userTouched = true;
  setPanelWidthRaw(clampPanelWidth(w));
  persist();
}

export function resetPanelWidth() {
  setPanelWidth(DEFAULT_PANEL_WIDTH);
}

/** Re-clamp after the window shrinks, so the panel can't exceed 70% of it. */
export function reclampPanelWidth() {
  const clamped = clampPanelWidth(panelWidth());
  if (clamped !== panelWidth()) {
    setPanelWidthRaw(clamped);
    persist();
  }
}
