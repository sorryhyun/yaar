/**
 * Custom properties a gesture drives per frame, written on the elements that read them.
 *
 * The monitor pan, the shade pull and the palette pull move their surfaces by writing a custom property
 * every touchmove and letting CSS place the element. They used to write it on `<html>`,
 * which is one line of code and one style recalc of the *whole document* per frame: a
 * custom property inherits, so every node under the root had its style recomputed for a
 * value three elements read. Measured with `make mobile-bench` (3 monitors × 6 windows,
 * ~9k nodes), that was ~600ms of style recalc over four swipes on a 4x-throttled phone.
 *
 * So the properties are registered non-inheriting (`@property … inherits: false`, next to
 * the rules that read them) and written here onto each element that asked for them with
 * `data-gesture-layer`. A change restyles those elements and nothing under them.
 *
 * The phase attribute (`data-monitor-peek`, `data-shade-pull`) stays on `<html>`: it
 * changes once per gesture, not per frame, and selector invalidation only touches the
 * elements its rules name.
 *
 * An element that mounts mid-gesture — the peek panel, the shade on its first pull — is
 * given the current values by `gestureLayerRef` as it attaches, so its first frame is
 * already where the finger is.
 */

export type GestureLayer = 'monitor-peek' | 'shade-pull' | 'palette-pull';

const current: Record<GestureLayer, Map<string, string>> = {
  'monitor-peek': new Map(),
  'shade-pull': new Map(),
  'palette-pull': new Map(),
};

function layerElements(layer: GestureLayer): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-gesture-layer~="${layer}"]`);
}

/** Publish one property to every element of `layer`. */
export function setGestureVar(layer: GestureLayer, name: string, value: string): void {
  current[layer].set(name, value);
  for (const el of layerElements(layer)) el.style.setProperty(name, value);
}

/** Take every property of `layer` back off its elements. */
export function clearGestureVars(layer: GestureLayer): void {
  const names = [...current[layer].keys()];
  current[layer].clear();
  for (const el of layerElements(layer)) for (const name of names) el.style.removeProperty(name);
}

/** The value last published — what the layer's elements are showing. */
export function getGestureVar(layer: GestureLayer, name: string): string {
  return current[layer].get(name) ?? '';
}

const refs = {} as Record<GestureLayer, (el: HTMLElement | null) => void>;

/**
 * A stable ref for an element of `layer`: catches it up on the values already published.
 * Pair it with `data-gesture-layer={layer}` so later writes find it too.
 */
export function gestureLayerRef(layer: GestureLayer): (el: HTMLElement | null) => void {
  return (refs[layer] ??= (el) => {
    if (el) for (const [name, value] of current[layer]) el.style.setProperty(name, value);
  });
}
