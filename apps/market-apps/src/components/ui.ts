// Small view primitives shared by more than one component. Everything here is
// presentation-only — no store reads, no actions — so it can be used from any
// component without dragging state along.

import html from '@bundled/solid-js/html';

/** The checked state of the checkbox that raised this event. */
export function targetChecked(e: Event): boolean {
  return (e.target as HTMLInputElement).checked;
}

/** The current value of the input or select that raised this event. */
export function targetValue(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement).value;
}

/**
 * Click-outside for a modal backdrop: fires only when the click landed on the dim
 * area itself, never on the card inside it. Both dialogs dismiss this way.
 */
export function onBackdropClick(dismiss: () => void): (e: Event) => void {
  return (e: Event) => {
    if (e.target === e.currentTarget) dismiss();
  };
}

/**
 * A small inline status pill — "Official", the publisher pencil, the installed tick.
 * `label` is the accessible name; `title` defaults to it and is split out only where
 * the tooltip should read more fully than the screen-reader label.
 */
export function badge(className: string, content: string, label: string, title = label) {
  return html`<span class=${className} title=${title} aria-label=${label}>${content}</span>`;
}