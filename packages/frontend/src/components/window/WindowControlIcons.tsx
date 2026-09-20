/**
 * The glyphs in a window's title bar, as line art.
 *
 * They used to be literal characters — `↑ − □ ×`, plus `⤢`/`⤡` for a card's full
 * screen — which meant every platform drew them from whichever font happened to
 * cover that codepoint: different weights, different optical sizes, and on a phone
 * the two corner arrows often missing entirely. Drawn here they are one stroke
 * weight on one 20×20 grid, and they inherit the button's colour.
 *
 * No width/height: `WindowFrame.module.css` sizes them, because the same icon is
 * 16px on a desktop title bar and larger inside a card's 40px touch target.
 */

const common = {
  viewBox: '0 0 20 20',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
} as const;

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** An arrow leaving the tray it sits in. */
export function ExportIcon() {
  return (
    <svg {...common}>
      <path d="M10 12.5V3.5" {...stroke} />
      <path d="M6.75 6.75L10 3.5L13.25 6.75" {...stroke} />
      <path
        d="M4.5 12.5v2.25c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V12.5"
        {...stroke}
      />
    </svg>
  );
}

export function MinimizeIcon() {
  return (
    <svg {...common}>
      <path d="M5 10h10" {...stroke} />
    </svg>
  );
}

export function MaximizeIcon() {
  return (
    <svg {...common}>
      <rect x="4.25" y="4.25" width="11.5" height="11.5" rx="2" {...stroke} />
    </svg>
  );
}

/** Maximize's other state: a smaller pane lifted off the one behind it. */
export function RestoreIcon() {
  return (
    <svg {...common}>
      <path
        d="M7.25 7.25V5.75c0-.83.67-1.5 1.5-1.5h5.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-1.5"
        {...stroke}
      />
      <rect x="4.25" y="7.25" width="8.5" height="8.5" rx="1.75" {...stroke} />
    </svg>
  );
}

/** Corners pushing out — the card's maximize. */
export function FullscreenIcon() {
  return (
    <svg {...common}>
      <path d="M11.75 4.25h4v4" {...stroke} />
      <path d="M8.25 15.75h-4v-4" {...stroke} />
      <path d="M15.75 4.25L11 9" {...stroke} />
      <path d="M4.25 15.75L9 11" {...stroke} />
    </svg>
  );
}

/** Corners pulling back in. */
export function ExitFullscreenIcon() {
  return (
    <svg {...common}>
      <path d="M15.75 9.25h-4v-4" {...stroke} />
      <path d="M4.25 10.75h4v4" {...stroke} />
      <path d="M15.75 5.25l-4 4" {...stroke} />
      <path d="M4.25 14.75l4-4" {...stroke} />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...common}>
      <path d="M5.25 5.25l9.5 9.5M14.75 5.25l-9.5 9.5" {...stroke} />
    </svg>
  );
}
