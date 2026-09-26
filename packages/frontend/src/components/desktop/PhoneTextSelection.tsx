/**
 * PhoneTextSelection - long-press to select a word in a window, with the shell's own menu.
 *
 * The phone half of `lib/textSelection`: window content there is `user-select: none`, so
 * Chrome's selection toolbar never comes up, and this puts back what the user lost with it.
 * A finger held still on a word selects that word; the menu over it offers Copy, Select all
 * and Ask AI — the last opening the same `SelectionActionInput` a desktop right-click on a
 * selection opens, handed the text directly, since there is no `getSelection()` to read.
 *
 * It covers windows the shell renders itself (markdown, table, text, components). An app
 * card is an iframe, and a touch inside one never reaches this document.
 *
 * A tap anywhere else clears the selection; a scroll keeps it and moves the menu with it,
 * as the native one does.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import { useDesktopStore } from '@/store';
import {
  claimTouch,
  clearTextSelection,
  getTextSelection,
  isTouchClaimed,
  rangeAll,
  releaseTouch,
  setTextSelection,
  subscribeTextSelection,
  wordRangeAt,
} from '@/lib/textSelection';
import { copyText } from '@/lib/copyText';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { SelectionActionInput } from '../window/SelectionActionInput';
import styles from '@/styles/desktop/PhoneTextSelection.module.css';

/** Android's own long-press timeout. */
export const LONG_PRESS_MS = 400;
/** A finger that wandered further than this was scrolling, not holding. */
const LONG_PRESS_SLOP_PX = 8;
/** Room kept between the menu and the screen edge, and between the menu and the word. */
const MENU_MARGIN_PX = 8;

/** Where selecting is not ours: fields keep the native selection, controls are pressed. */
const NOT_SELECTABLE =
  'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [data-no-select]';

interface Press {
  x: number;
  y: number;
  content: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
}

interface Asking {
  x: number;
  y: number;
  text: string;
  windowId: string;
  windowTitle: string;
}

/** The window content box a touch landed in, if it is one text can be selected from. */
function selectableContentAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(NOT_SELECTABLE)) return null;
  return target.closest<HTMLElement>('[data-window-content]');
}

function contentOf(range: Range): HTMLElement | null {
  const start = range.startContainer;
  const el = start instanceof Element ? start : start.parentElement;
  return el?.closest<HTMLElement>('[data-window-content]') ?? null;
}

function windowIdOf(content: HTMLElement): string | null {
  return content.closest(`[${WINDOW_ID_DATA_ATTR}]`)?.getAttribute(WINDOW_ID_DATA_ATTR) ?? null;
}

export function PhoneTextSelection() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const selection = useSyncExternalStore(subscribeTextSelection, getTextSelection);
  const [asking, setAsking] = useState<Asking | null>(null);
  // Bumped on scroll and resize, so the menu is re-placed over a word that moved.
  const [layoutTick, setLayoutTick] = useState(0);

  useEffect(() => {
    if (!isMobile) return;
    let press: Press | null = null;
    let moved = false;

    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      releaseTouch();
      cancelPress();
      moved = false;
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) return;
      const content = selectableContentAt(e.target);
      if (!content) return;
      const { clientX: x, clientY: y } = touch;
      press = {
        x,
        y,
        content,
        timer: setTimeout(() => {
          press = null;
          const windowId = windowIdOf(content);
          const range = windowId ? wordRangeAt(content, x, y) : null;
          if (!range || !windowId) return;
          claimTouch();
          setTextSelection(range, windowId);
        }, LONG_PRESS_MS),
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (isTouchClaimed()) {
        // The word is chosen; the finger moving on is not a scroll of what is under it.
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (!press || !touch) {
        moved = true;
        return;
      }
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > LONG_PRESS_SLOP_PX) {
        moved = true;
        cancelPress();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      cancelPress();
      if (isTouchClaimed()) {
        // The browser would follow the lift with a click on whatever held the word.
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (moved) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-text-selection-menu]')) return;
      clearTextSelection();
    };

    // A long-press is also Chrome's context-menu gesture: a link's "open in new tab" sheet
    // would come up over the word being selected.
    const onContextMenu = (e: MouseEvent) => {
      if (selectableContentAt(e.target)) e.preventDefault();
    };

    const onLayout = () => {
      if (getTextSelection()) setLayoutTick((n) => n + 1);
    };

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    // Not passive: a claimed touch has to stop the page scrolling under it.
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', cancelPress, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('scroll', onLayout, { capture: true, passive: true });
    globalThis.addEventListener('resize', onLayout);
    return () => {
      cancelPress();
      releaseTouch();
      clearTextSelection();
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', cancelPress, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('scroll', onLayout, true);
      globalThis.removeEventListener('resize', onLayout);
    };
  }, [isMobile]);

  const closeAsking = useCallback(() => {
    setAsking(null);
    clearTextSelection();
  }, []);

  if (!isMobile) return null;
  if (asking) {
    return (
      <SelectionActionInput
        x={asking.x}
        y={asking.y}
        selectedText={asking.text}
        windowId={asking.windowId}
        windowTitle={asking.windowTitle}
        isRegion={false}
        onClose={closeAsking}
      />
    );
  }
  if (!selection) return null;
  return (
    <SelectionMenu
      range={selection.range}
      windowId={selection.windowId}
      layoutTick={layoutTick}
      onAsk={setAsking}
    />
  );
}

interface SelectionMenuProps {
  range: Range;
  windowId: string;
  layoutTick: number;
  onAsk: (asking: Asking) => void;
}

function SelectionMenu({ range, windowId, layoutTick, onAsk }: SelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Above the word when there is room, under it when there is not, and never off the side
  // of the screen. Measured after render, since the menu's width is its labels'.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
      // The text under the range was re-rendered away.
      clearTextSelection();
      return;
    }
    const rect = range.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu;
    const above = rect.top - height - MENU_MARGIN_PX;
    const top = above >= MENU_MARGIN_PX ? above : rect.bottom + MENU_MARGIN_PX;
    const centred = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(
      MENU_MARGIN_PX,
      Math.min(centred, globalThis.innerWidth - width - MENU_MARGIN_PX),
    );
    setPlace({ left, top });
  }, [range, layoutTick]);

  const copy = async () => {
    const ok = await copyText(range.toString());
    clearTextSelection();
    useDesktopStore.getState().applyAction({
      type: 'toast.show',
      id: `copy-${Date.now()}`,
      message: i18next.t(ok ? 'textSelection.copied' : 'textSelection.copyFailed'),
      variant: ok ? 'info' : 'error',
    });
  };

  const selectAll = () => {
    const content = contentOf(range);
    if (content) setTextSelection(rangeAll(content), windowId);
  };

  const ask = () => {
    const rect = range.getBoundingClientRect();
    const win = Object.values(useDesktopStore.getState().windows).find((w) => w.id === windowId);
    onAsk({
      x: Math.max(MENU_MARGIN_PX, rect.left),
      y: rect.bottom,
      text: range.toString().trim(),
      windowId,
      windowTitle: win?.title ?? windowId,
    });
  };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      data-text-selection-menu
      data-no-pan
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
    >
      <button type="button" role="menuitem" className={styles.item} onClick={copy}>
        {t('textSelection.copy')}
      </button>
      <button type="button" role="menuitem" className={styles.item} onClick={selectAll}>
        {t('textSelection.selectAll')}
      </button>
      <button type="button" role="menuitem" className={styles.item} onClick={ask}>
        {t('textSelection.askAi')}
      </button>
    </div>
  );
}
