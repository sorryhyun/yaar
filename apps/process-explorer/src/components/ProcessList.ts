export {};

import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';

export interface ProcessListProps<T> {
  /**
   * The rows. Pass the signal itself (`each=${agentList}`) — `html` unwraps a
   * function prop into a reactive getter, so what arrives here is the array, and
   * reading it inside a thunk still tracks.
   */
  each: T[];
  /**
   * Glyph for the empty state. Pass the literal character: an HTML entity
   * interpolated through `${}` is set as text and would render as its own source.
   */
  icon: string;
  /** Empty-state line, e.g. "No agents running". */
  emptyText: string;
  /**
   * Renders one row. Passed as *children*, not as a prop, for the same unwrapping
   * reason: a function prop would be called during render. This is exactly how
   * `For` takes its row renderer.
   */
  children: (item: T) => unknown;
}

/**
 * The list shell every tab shares: rows when there are any, a centred empty state
 * when there are none. All three tabs differed only in signal, row renderer,
 * glyph and wording.
 *
 * Callers must keep the children function tight against the tags —
 * `>${(x) => ...}</>` with no surrounding whitespace — or the whitespace becomes
 * sibling text children and `children` arrives as an array instead of a function.
 */
export function ProcessList<T>(props: ProcessListProps<T>) {
  // Built eagerly: `icon` and `emptyText` are fixed for the life of an instance,
  // and Show wants an element rather than an accessor here.
  const fallback = html`<div class="y-empty"><div class="y-empty-icon">${props.icon}</div>${props.emptyText}</div>`;

  return html`
    <${Show} when=${() => props.each.length > 0} fallback=${fallback}>
      <${For} each=${() => props.each}>${props.children}</>
    </>
  `;
}
