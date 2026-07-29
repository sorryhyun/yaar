/**
 * dock.ts — hover-reveal side panels.
 *
 * Both side panels are closed by default and collapsed to a thin rail. Moving
 * the pointer into the rail (or the open panel) slides the panel out over the
 * viewport; leaving slides it shut. The panels *overlay* the viewport rather
 * than sitting in the grid, so opening one never resizes the canvas and the
 * renderer's ResizeObserver never fires.
 *
 * Three things suppress the auto-open/auto-close:
 *   - the pin toggle in the panel header (sustained editing),
 *   - an in-flight pointer drag that started in the viewport (orbit/pan),
 *   - focus sitting on an input inside the panel.
 */
import { createSignal } from '@bundled/solid-js';

/** True while a pointer drag that began inside the viewport is in flight. */
const [viewportDragging, setViewportDragging] = createSignal(false);

export { viewportDragging };

/**
 * Per-side open state, published so the viewport can nudge its HUD overlays
 * clear of an open panel. Read-only outside this module.
 */
const [leftOpen, setLeftOpen] = createSignal(false);
const [rightOpen, setRightOpen] = createSignal(false);

export const dockOpen = { left: leftOpen as () => boolean, right: rightOpen as () => boolean };

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

export function createDock(side: 'left' | 'right'): DockState {
  const [openRaw, setOpenRaw] = createSignal(false);
  const open = openRaw;
  const publish = side === 'left' ? setLeftOpen : setRightOpen;
  const setOpen = (v: boolean): void => {
    setOpenRaw(v);
    publish(v);
  };
  const [pinned, setPinned] = createSignal(false);
  let root: HTMLElement | null = null;
  let hovering = false;
  let timer = 0;

  /** An input inside this panel holds focus — the user is typing, keep it open. */
  const holdsFocus = (): boolean =>
    !!root && isEditable(document.activeElement) && root.contains(document.activeElement);

  const maybeClose = (): void => {
    if (pinned() || hovering || holdsFocus()) return;
    setOpen(false);
  };

  const scheduleClose = (): void => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      maybeClose();
    }, CLOSE_DELAY_MS);
  };

  return {
    open,
    pinned,
    cls: () =>
      ['dock', `dock-${side}`, open() ? 'dock-open' : '', pinned() ? 'dock-pinned' : '']
        .filter(Boolean)
        .join(' '),
    togglePin: () => {
      const next = !pinned();
      setPinned(next);
      if (next) setOpen(true);
      else scheduleClose();
    },
    onEnter: () => {
      hovering = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      // Never slide open mid-orbit: the pointer is only over the rail because
      // the drag swept across it.
      if (viewportDragging()) return;
      setOpen(true);
    },
    onLeave: () => {
      hovering = false;
      scheduleClose();
    },
    attach: (el: HTMLElement) => {
      root = el;
      // Blur of a field inside the panel re-arms the close check, so a panel
      // held open by a focused input shuts once focus leaves it.
      el.addEventListener('focusout', () => scheduleClose());
    },
  };
}

/** Markup for the collapsed edge rail. Shared by both panels. */
export function railTitle(label: string): string {
  return `${label} — hover to open`;
}
