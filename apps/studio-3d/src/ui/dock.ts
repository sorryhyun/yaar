/**
 * dock.ts — hover-reveal side panels.
 *
 * Both side panels are closed by default and collapsed to a thin rail. Moving
 * the pointer into the rail (or the open panel) slides the panel out over the
 * viewport; leaving slides it shut. The panels *overlay* the viewport rather
 * than sitting in the grid, so opening one never resizes the canvas and the
 * renderer's ResizeObserver never fires.
 *
 * The open/pin state machine is the shared `createCollapsiblePanel` primitive
 * from `@bundled/yaar` — including the persisted pin, which this module used to
 * lack. Only what is specific to a 3D viewport lives here, expressed through the
 * primitive's two gates:
 *
 *   canOpen  — an orbit/pan drag that began in the viewport routinely sweeps the
 *              pointer across a rail. Opening on that is never what was meant.
 *   holdOpen — a field inside the panel holds focus, so the user is typing; the
 *              `focusout` handler re-arms the fold once focus leaves.
 */
import { createCollapsiblePanel } from '@bundled/yaar';
import { createSignal } from '@bundled/solid-js';

/** True while a pointer drag that began inside the viewport is in flight. */
const [viewportDragging, setViewportDragging] = createSignal(false);

export { viewportDragging };

/** Install the global viewport-drag guard. Returns a cleanup function. */
export function installDragGuard(): () => void {
  const down = (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('.vp')) setViewportDragging(true);
  };
  const up = () => setViewportDragging(false);
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('blur', up);
  };
}

export interface DockState {
  open: () => boolean;
  pinned: () => boolean;
  /** class list for the dock root element */
  cls: () => string;
  togglePin: () => void;
  onEnter: () => void;
  onLeave: () => void;
  /** ref callback for the dock root element */
  attach: (el: HTMLElement) => void;
}

const CLOSE_DELAY_MS = 140;

function isEditable(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

function createDockState(side: 'left' | 'right'): DockState {
  let root: HTMLElement | null = null;

  const panel = createCollapsiblePanel({
    pinKey: `dock-pin-${side}.json`,
    pinLabel: `${side} panel pin`,
    closeDelayMs: CLOSE_DELAY_MS,
    canOpen: () => !viewportDragging(),
    holdOpen: () =>
      !!root && isEditable(document.activeElement) && root.contains(document.activeElement),
  });

  return {
    open: panel.expanded,
    pinned: panel.pinned,
    cls: () =>
      [
        'dock',
        `dock-${side}`,
        panel.expanded() ? 'dock-open' : '',
        panel.pinned() ? 'dock-pinned' : '',
      ]
        .filter(Boolean)
        .join(' '),
    togglePin: panel.togglePin,
    onEnter: panel.open,
    onLeave: panel.scheduleClose,
    attach: (el: HTMLElement) => {
      root = el;
      // Blur of a field inside the panel re-arms the close check, so a panel
      // held open by `holdOpen` shuts once focus leaves it.
      el.addEventListener('focusout', () => panel.scheduleClose());
    },
  };
}

/**
 * The two docks are created here, not in the panel components, so the viewport
 * can read their open state (to nudge its HUD overlays clear) without importing
 * SceneTree or Inspector.
 */
export const leftDock = createDockState('left');
export const rightDock = createDockState('right');

/** Per-side open state, for layout that has to react to an open panel. */
export const dockOpen = { left: leftDock.open, right: rightDock.open };

/** Markup for the collapsed edge rail. Shared by both panels. */
export function railTitle(label: string): string {
  return `${label} — hover to open`;
}
