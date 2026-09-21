export {};
import html from '@bundled/solid-js/html';

// Stroke icons drawn in currentColor, so they take the colour and hover state of
// whatever button or row holds them (emoji render differently on every platform).

const PATHS = {
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  eye: '<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>',
  upload:
    '<path d="M12 16V4"/><polyline points="6.5 9.5 12 4 17.5 9.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  folder:
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(name: IconName, extraClass = '') {
  return html`<svg
    class=${`dt-icon ${extraClass}`}
    viewBox="0 0 24 24"
    aria-hidden="true"
    innerHTML=${PATHS[name]}
  ></svg>`;
}
