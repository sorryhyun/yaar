/**
 * The position/size style for a window frame — split out of `WindowFrame` because it is
 * pure (no hooks, no DOM), so it is cheaper to unit-test as a function than through a render.
 */
import type { CSSProperties } from 'react';
import type { WindowModel } from '@/types/state';

export interface WindowStyleInput {
  window: WindowModel;
  zIndex: number;
  /** Mobile card: fills the screen above the command palette, ignores bounds/maximize. */
  isCard: boolean;
  /** A card blown up over the command palette too — the phone's stand-in for maximize. */
  isFullscreen: boolean;
  isPanel: boolean;
  isWidget: boolean;
}

/** Mirrors the precedence in `WindowFrame`: card > custom `windowStyle` > panel > maximized > widget > default. */
export function computeWindowStyle({
  window,
  zIndex,
  isCard,
  isFullscreen,
  isPanel,
  isWidget,
}: WindowStyleInput): CSSProperties {
  if (isCard) {
    return {
      top: 0,
      left: 0,
      width: '100%',
      // --palette-h is published by CommandPalette as it grows and shrinks.
      height: isFullscreen ? '100%' : 'calc(100% - var(--palette-h, 0px))',
      zIndex: zIndex + 100,
    };
  }
  if (window.windowStyle) {
    // Custom CSS positioning from app.json windowStyle
    return {
      top: window.bounds.y,
      left: window.bounds.x,
      width: window.bounds.w,
      height: window.bounds.h,
      zIndex: isPanel ? 9000 : zIndex + 100,
      ...window.windowStyle,
    };
  }
  if (isPanel) {
    const edge = window.dockEdge ?? 'bottom';
    return {
      position: 'fixed',
      left: 0,
      width: '100%',
      height: window.bounds.h,
      zIndex: 9000,
      ...(edge === 'top' ? { top: 0 } : { bottom: 0 }),
    };
  }
  if (window.maximized) {
    return {
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: zIndex + 100,
    };
  }
  if (isWidget) {
    return {
      top: window.bounds.y,
      left: window.bounds.x,
      width: window.bounds.w,
      height: window.bounds.h,
      zIndex, // No +100 offset — keeps widgets below standard windows
    };
  }
  return {
    top: window.bounds.y,
    left: window.bounds.x,
    width: window.bounds.w,
    height: window.bounds.h,
    zIndex: zIndex + 100,
  };
}
