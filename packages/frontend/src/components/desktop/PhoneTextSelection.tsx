/**
 * PhoneTextSelection - long-press to select text in a window, with the shell's own
 * handles and menu.
 *
 * The phone half of `lib/textSelection`: window content there is `user-select: none`, so
 * Chrome's selection toolbar never comes up, and this puts back what the user lost with it.
 * A finger held still on a word selects that word; two handles at its ends drag either end
 * anywhere in the window — across paragraphs, and past the top or bottom, which scrolls —
 * and the menu over it offers Copy, Select all and Ask AI, the last opening the same
 * `SelectionActionInput` a desktop right-click on a selection opens, handed the text
 * directly, since there is no `getSelection()` to read.
 *
 * Windows the shell renders itself (markdown, table, text, components) are selected here.
 * An app card is an iframe whose touches never reach this document, so the frame's own
 * script does the long-press and holds the range, and reports it (`APP_MSG.textSelection`);
 * the handles and the menu for it are still these ones, which is what keeps the two alike.
 *
 * A tap anywhere else clears the selection; a scroll keeps it and moves the handles and
 * the menu with it, as the native one does.
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
import { APP_MSG } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import {
  NOT_SELECTABLE,
  claimTouch,
  clearTextSelection,
  dragHandle,
  getTextSelection,
  isTouchClaimed,
  releaseTouch,
  selectAll,
  selectionGeometry,
  selectionText,
  setFrameTextSelection,
  setTextSelection,
  subscribeTextSelection,
  wordRangeAt,
  type Box,
  type CaretLine,
  type FrameSelectionReport,
  type HandleDrag,
  type SelectionEnd,
  type SelectionGeometry,
  type TextSelection,
} from '@/lib/textSelection';
import { copyText } from '@/lib/copyText';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { SelectionActionInput } from '../window/SelectionActionInput';
import styles from '@/styles/desktop/PhoneTextSelection.module.css';

/** Android's own long-press timeout. The frame script's copy is `LONG_PRESS_MS` there. */
export const LONG_PRESS_MS = 400;
/** A finger that wandered further than this was scrolling, not holding. */
const LONG_PRESS_SLOP_PX = 8;
/** Room kept between the menu and the screen edge, and between the menu and the text. */
const MENU_MARGIN_PX = 8;
/** The drawn handle; its touch target is larger (see the stylesheet). */
export const HANDLE_SIZE_PX = 22;

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

function windowIdOf(content: HTMLElement): string | null {
  return content.closest(`[${WINDOW_ID_DATA_ATTR}]`)?.getAttribute(WINDOW_ID_DATA_ATTR) ?? null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function caretLineOf(v: unknown): CaretLine | null {
  const o = v as Record<string, unknown> | null;
  const x = num(o?.x);
  const top = num(o?.top);
  const bottom = num(o?.bottom);
  return x === null || top === null || bottom === null ? null : { x, top, bottom };
}

function boxFrom(v: unknown): Box | null {
  const o = v as Record<string, unknown> | null | undefined;
  const left = num(o?.left);
  const top = num(o?.top);
  const width = num(o?.width);
  const height = num(o?.height);
  if (left === null || top === null || width === null || height === null) return null;
  return { left, top, width, height };
}

/**
 * A frame's `selection` field: `null` is the frame saying it has none, `undefined` a
 * message too malformed to act on either way.
 */
export function parseFrameReport(v: unknown): FrameSelectionReport | null | undefined {
  if (v === null) return null;
  const o = v as Record<string, unknown> | undefined;
  const start = caretLineOf(o?.start);
  const end = caretLineOf(o?.end);
  const bounds = boxFrom(o?.bounds);
  if (!start || !end || !bounds) return undefined;
  const text = typeof o?.text === 'string' ? o.text : undefined;
  return { text, start, end, bounds, clip: boxFrom(o?.clip) ?? undefined };
}

export function PhoneTextSelection() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const selection = useSyncExternalStore(subscribeTextSelection, getTextSelection);
  const [asking, setAsking] = useState<Asking | null>(null);
  // Bumped on scroll and resize: the re-render is what re-measures the handles and the
  // menu over text that moved.
  const [, setLayoutTick] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!isMobile) return;
    let press: Press | null = null;
    let moved = false;
    let handleDrag: HandleDrag | null = null;

    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };

    const endHandleDrag = () => {
      if (!handleDrag) return;
      handleDrag.end();
      handleDrag = null;
      setDragging(false);
    };

    const onTouchStart = (e: TouchEvent) => {
      releaseTouch();
      cancelPress();
      endHandleDrag();
      moved = false;
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) return;
      const { clientX: x, clientY: y } = touch;

      // A handle is claimed at once, not after a hold: it has no other use for the touch,
      // and `PhoneGestures` must never read its drag as a pan or a pull.
      const handle =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>('[data-text-selection-handle]')
          : null;
      const current = getTextSelection();
      if (handle && current) {
        const end: SelectionEnd = handle.dataset.textSelectionHandle === 'start' ? 'start' : 'end';
        handleDrag = dragHandle(current, end, x, y);
        if (handleDrag) {
          claimTouch();
          setDragging(true);
        }
        return;
      }

      const content = selectableContentAt(e.target);
      if (!content) return;
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
      if (handleDrag && touch) {
        if (e.cancelable) e.preventDefault();
        handleDrag.to(touch.clientX, touch.clientY);
        return;
      }
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
      endHandleDrag();
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

    const onTouchCancel = () => {
      cancelPress();
      endHandleDrag();
    };

    // A long-press is also Chrome's context-menu gesture: a link's "open in new tab" sheet
    // would come up over the word being selected.
    const onContextMenu = (e: MouseEvent) => {
      if (selectableContentAt(e.target)) e.preventDefault();
    };

    const onLayout = () => {
      if (getTextSelection()) setLayoutTick((n) => n + 1);
    };

    // A pan, a shade pull or a palette pull under way — from this document or relayed
    // out of an app frame — moves the desktop out from under the text, or covers it, and
    // the handles and the menu float above all of it. Each of them marks itself on
    // `<html>` (`lib/gesture-layer`'s callers), which is the one place all of them meet.
    const gestures = new MutationObserver(() => {
      const root = document.documentElement.dataset;
      if (root.monitorPeek || root.shadePull || root.palettePull) clearTextSelection();
    });
    gestures.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-monitor-peek', 'data-shade-pull', 'data-palette-pull'],
    });

    const offReport = iframeMessages.on(APP_MSG.textSelection, ({ data, source }) => {
      if (!source) return;
      const report = parseFrameReport(data?.selection);
      if (report !== undefined) setFrameTextSelection(source.iframe, source.windowId, report);
    });
    // A tap inside an app frame never reaches the touch listeners here, but it is still a
    // tap somewhere else — unless it was in the frame holding the selection, which clears
    // its own and says so.
    const offFrameClick = iframeMessages.on(APP_MSG.click, ({ source }) => {
      const current = getTextSelection();
      if (!current || (current.kind === 'frame' && current.iframe === source?.iframe)) return;
      clearTextSelection();
    });

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    // Not passive: a claimed touch has to stop the page scrolling under it.
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchCancel, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('scroll', onLayout, { capture: true, passive: true });
    globalThis.addEventListener('resize', onLayout);
    return () => {
      cancelPress();
      endHandleDrag();
      releaseTouch();
      clearTextSelection();
      gestures.disconnect();
      offReport();
      offFrameClick();
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchCancel, true);
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
  return <SelectionOverlay selection={selection} dragging={dragging} onAsk={setAsking} />;
}

interface SelectionOverlayProps {
  selection: TextSelection;
  dragging: boolean;
  onAsk: (asking: Asking) => void;
}

function SelectionOverlay({ selection, dragging, onAsk }: SelectionOverlayProps) {
  // Measured on every render, not memoised: a scroll moves the text without changing
  // the selection, and the re-render it causes is the one that has to see that.
  const geometry = selectionGeometry(selection);

  useEffect(() => {
    // The text under the range was re-rendered away, or its frame closed.
    if (!geometry) clearTextSelection();
  }, [geometry]);

  if (!geometry) return null;
  const { clip } = geometry;
  // A handle scrolled out of its window — or hanging off text an ellipsis cut short — is
  // not drawn over whatever is outside it. Hidden, never unmounted: the dragged one is its
  // touch's target, and a target taken out of the document takes the rest of the touch
  // with it — the moves and the lift stop reaching the listeners here.
  const shows = (line: CaretLine) =>
    line.bottom > clip.top &&
    line.top < clip.top + clip.height &&
    line.x >= clip.left - 1 &&
    line.x <= clip.left + clip.width + 1;

  return (
    <>
      {(['start', 'end'] as const).map((end) => {
        const line = geometry[end];
        return (
          <div
            key={end}
            className={`${styles.handle} ${styles[end]}`}
            data-text-selection-handle={end}
            data-no-pan
            data-dragging={dragging || undefined}
            style={{
              left: end === 'start' ? line.x - HANDLE_SIZE_PX : line.x,
              top: line.bottom,
              width: HANDLE_SIZE_PX,
              height: HANDLE_SIZE_PX,
              visibility: shows(line) ? undefined : 'hidden',
            }}
          />
        );
      })}
      {/* Out of the way while a handle moves; back on the lift, over the new range. */}
      {!dragging && <SelectionMenu selection={selection} geometry={geometry} onAsk={onAsk} />}
    </>
  );
}

interface SelectionMenuProps {
  selection: TextSelection;
  geometry: SelectionGeometry;
  onAsk: (asking: Asking) => void;
}

/** The part of the selection's box its window shows, top to bottom. */
function visibleSpan({ bounds, clip }: SelectionGeometry): { top: number; bottom: number } {
  return {
    top: Math.max(bounds.top, clip.top),
    bottom: Math.min(bounds.top + bounds.height, clip.top + clip.height),
  };
}

function SelectionMenu({ selection, geometry, onAsk }: SelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Above the text when there is room, under it — clear of the handles — when there is
  // not, and never off the screen: a selection taller than the window has neither, and
  // the menu then sits over it. Measured after render, since the menu's width is its
  // labels'.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { bounds } = geometry;
    const span = visibleSpan(geometry);
    const { offsetWidth: width, offsetHeight: height } = menu;
    const above = span.top - height - MENU_MARGIN_PX;
    const below = span.bottom + HANDLE_SIZE_PX + MENU_MARGIN_PX;
    const maxTop = globalThis.innerHeight - height - MENU_MARGIN_PX;
    const top = above >= MENU_MARGIN_PX ? above : Math.max(MENU_MARGIN_PX, Math.min(below, maxTop));
    const centred = bounds.left + bounds.width / 2 - width / 2;
    const left = Math.max(
      MENU_MARGIN_PX,
      Math.min(centred, globalThis.innerWidth - width - MENU_MARGIN_PX),
    );
    setPlace({ left, top });
  }, [geometry]);

  const copy = async () => {
    const ok = await copyText(selectionText(selection));
    clearTextSelection();
    useDesktopStore.getState().applyAction({
      type: 'toast.show',
      id: `copy-${Date.now()}`,
      message: i18next.t(ok ? 'textSelection.copied' : 'textSelection.copyFailed'),
      variant: ok ? 'info' : 'error',
    });
  };

  const ask = () => {
    const { windowId } = selection;
    const win = Object.values(useDesktopStore.getState().windows).find((w) => w.id === windowId);
    onAsk({
      x: Math.max(MENU_MARGIN_PX, geometry.bounds.left),
      y: visibleSpan(geometry).bottom,
      text: selectionText(selection).trim(),
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
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => selectAll(selection)}
      >
        {t('textSelection.selectAll')}
      </button>
      <button type="button" role="menuitem" className={styles.item} onClick={ask}>
        {t('textSelection.askAi')}
      </button>
    </div>
  );
}
