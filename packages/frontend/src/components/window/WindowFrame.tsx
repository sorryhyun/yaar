/**
 * WindowFrame - Draggable, resizable window container.
 *
 * On a phone (`formFactor === 'mobile'`) a standard window is a *card* instead: it fills
 * the screen above the command palette, cannot be dragged or resized, and z-order alone
 * decides which one shows — the taskbar tabs are the app switcher.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useDesktopStore,
  selectQueuedActionsCount,
  selectWindowAgent,
  selectFullscreenCardId,
} from '@/store';
import { useComponentAction } from '@/contexts/ComponentActionContext';
import { WindowCallbackProvider } from '@/contexts/WindowCallbackContext';
import type { WindowModel } from '@/types/state';
import { MemoizedContentRenderer } from './ContentRenderer';
import { RendererErrorBoundary } from './RendererErrorBoundary';
import { LockOverlay } from './LockOverlay';
import { SnapPreview } from './SnapPreview';
import { SelectionActionInput } from './SelectionActionInput';
import {
  CloseIcon,
  ExitFullscreenIcon,
  ExportIcon,
  FullscreenIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
} from './WindowControlIcons';
import { exportContent } from '@/lib/exportContent';
import { useDragWindow } from '@/hooks/useDragWindow';
import { beginShellDrag } from '@/lib/selection';
import { useResizeWindow } from '@/hooks/useResizeWindow';
import { useWindowDrop } from '@/hooks/useWindowDrop';
import { computeWindowStyle } from './windowStyle';
import styles from '@/styles/window/WindowFrame.module.css';

interface WindowFrameProps {
  window: WindowModel;
  zIndex: number;
  isFocused: boolean;
  hidden?: boolean;
}

const TITLE_BAR_DOUBLE_CLICK_MS = 250;
const TITLE_BAR_CLICK_MOVE_TOLERANCE = 3;

function WindowFrameInner({ window, zIndex, isFocused, hidden }: WindowFrameProps) {
  const { t } = useTranslation();
  const variant = window.variant ?? 'standard';
  const isWidget = variant === 'widget';
  const isPanel = variant === 'panel';
  const isFrameless = !!window.frameless;
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  // windowStyle windows position themselves (docks, overlays); they keep doing so.
  const isCard = isMobile && !isWidget && !isPanel && !window.windowStyle;
  // A card blown up over the command palette too — the phone's stand-in for maximize.
  const isFullscreen = useDesktopStore((s) => selectFullscreenCardId(s) === window.id);

  // Subscribe to individual stable action refs — never triggers re-renders
  const userFocusWindow = useDesktopStore((s) => s.userFocusWindow);
  const userCloseWindow = useDesktopStore((s) => s.userCloseWindow);
  // Live per-window state — re-renders on change
  const queuedCount = useDesktopStore(selectQueuedActionsCount(window.id));
  const windowAgent = useDesktopStore(selectWindowAgent(window.id));
  const isSelected = useDesktopStore((s) => s.selectedWindowIds.includes(window.id));
  const sendComponentAction = useComponentAction();

  const onComponentAction = useCallback(
    (
      action: string,
      parallel?: boolean,
      formData?: Record<string, string | number | boolean>,
      formId?: string,
      componentPath?: string[],
    ) => {
      sendComponentAction?.(
        window.id,
        window.title,
        action,
        parallel,
        formData,
        formId,
        componentPath,
      );
    },
    [sendComponentAction, window.id, window.title],
  );

  // Stabilize render callbacks — use getState() inside to avoid addRenderingFeedback dep
  const windowId = window.id;
  const onRenderSuccess = useCallback((requestId: string, winId: string, renderer: string) => {
    useDesktopStore
      .getState()
      .addRenderingFeedback({ requestId, windowId: winId, renderer, success: true });
  }, []);
  const onRenderError = useCallback(
    (requestId: string, winId: string, renderer: string, error: string, url?: string) => {
      useDesktopStore
        .getState()
        .addRenderingFeedback({ requestId, windowId: winId, renderer, success: false, error, url });
    },
    [],
  );

  const windowCallbacks = useMemo(
    () => ({ onRenderSuccess, onRenderError, onComponentAction }),
    [onRenderSuccess, onRenderError, onComponentAction],
  );

  // Selection action input state
  const [selectionAction, setSelectionAction] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  // The nonce a window mounts with is history, not news: a window remounted by a monitor
  // switch must not replay a glow for a change the user already saw.
  const mountChangeNonceRef = useRef(window.changeNonce ?? 0);
  const changeNonce = window.changeNonce ?? 0;

  const frameRef = useRef<HTMLDivElement>(null);
  const titleBarMouseDownRef = useRef<{ x: number; y: number } | null>(null);
  const lastTitleBarClickRef = useRef<number | null>(null);
  // --- Extracted hooks ---
  const { isDragging, snapPreviewBounds, handleDragStart } = useDragWindow({
    windowId: window.id,
    bounds: window.bounds,
    variant: window.variant,
    frameless: window.frameless,
  });

  const { isResizing, handleResizeStart } = useResizeWindow({
    windowId: window.id,
    bounds: window.bounds,
  });

  const { isDragOver, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } =
    useWindowDrop({
      windowId: window.id,
      windowTitle: window.title,
    });

  // Handle window focus
  const handleMouseDown = useCallback(() => {
    userFocusWindow(window.id);
  }, [userFocusWindow, window.id]);

  // Handle titlebar drag start — skip if clicking controls
  const handleTitleBarDragStart = useCallback(
    (e: React.MouseEvent) => {
      // The controls row and its gutters are `user-select: none`, which makes a
      // double-click there select the whole window body in Chrome. Suppress that
      // before bailing out of the drag, not after.
      const target = e.target as HTMLElement;
      if (target.closest(`.${styles.controls}`) || target.closest(`.${styles.widgetClose}`)) {
        beginShellDrag(e);
        return;
      }
      titleBarMouseDownRef.current = { x: e.clientX, y: e.clientY };
      handleDragStart(e);
    },
    [handleDragStart],
  );

  const handleTitleBarClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return;
      const start = titleBarMouseDownRef.current;
      titleBarMouseDownRef.current = null;
      if (
        !start ||
        Math.abs(e.clientX - start.x) > TITLE_BAR_CLICK_MOVE_TOLERANCE ||
        Math.abs(e.clientY - start.y) > TITLE_BAR_CLICK_MOVE_TOLERANCE
      ) {
        lastTitleBarClickRef.current = null;
        return;
      }

      const now = performance.now();
      const previousClick = lastTitleBarClickRef.current;
      lastTitleBarClickRef.current = now;
      if (previousClick === null) return;

      const elapsed = now - previousClick;
      if (elapsed <= 0 || elapsed > TITLE_BAR_DOUBLE_CLICK_MS) return;

      lastTitleBarClickRef.current = null;
      const current = useDesktopStore.getState().windows[window.id];
      if (!current) return;
      useDesktopStore.getState().applyAction({
        type: current.maximized ? 'window.restore' : 'window.maximize',
        windowId: window.id,
      });
    },
    [window.id],
  );

  // Widget drag: combines focus + drag on frame mousedown
  const handleWidgetDragStart = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(`.${styles.widgetClose}`)) {
        beginShellDrag(e);
        return;
      }
      userFocusWindow(window.id);
      handleDragStart(e);
    },
    [userFocusWindow, window.id, handleDragStart],
  );

  // Determine position/size (handle maximized state and variants)
  const style = computeWindowStyle({ window, zIndex, isCard, isFullscreen, isPanel, isWidget });

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={style}
      data-window-id={window.id}
      data-variant={variant}
      data-frameless={isFrameless || undefined}
      data-card={isCard || undefined}
      data-fullscreen={isFullscreen || undefined}
      data-hidden={hidden || undefined}
      data-focused={isFocused}
      data-selected={isSelected}
      data-dragging={isDragging}
      data-resizing={isResizing}
      data-drag-over={isDragOver}
      data-agent-active={windowAgent?.status === 'active'}
      onMouseDown={isWidget ? handleWidgetDragStart : handleMouseDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Widget close button (appears on hover) */}
      {isWidget && (
        <button
          className={styles.widgetClose}
          onClick={() => userCloseWindow(window.id)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ×
        </button>
      )}

      {/* Title bar — standard variant only (hidden for frameless). A full-screen card is
          all content: Back or a sideways swipe off the card is the way out, not a button. */}
      {!isWidget && !isPanel && !isFrameless && !isFullscreen && (
        <div
          className={styles.titleBar}
          onMouseDown={isCard ? undefined : handleTitleBarDragStart}
          onClick={isCard ? undefined : handleTitleBarClick}
        >
          <div className={styles.titleSection}>
            <div className={styles.title}>{window.title}</div>
            {window.unseenChange && (
              <span className={styles.changedBadge}>{t('window.changed')}</span>
            )}
            {window.locked && (
              <div
                className={styles.lockBadge}
                title={t('window.lockedBy', { agent: window.lockedBy || 'unknown' })}
              >
                <span className={styles.lockIcon}>🔒</span>
              </div>
            )}
            {windowAgent && (
              <div
                className={styles.agentBadge}
                data-status={windowAgent.status}
                title={t('window.poolAgent', {
                  agentId: windowAgent.agentId,
                  status: windowAgent.status,
                })}
              >
                <span className={styles.agentIcon}>
                  {windowAgent.status === 'active' ? '⚡' : '💤'}
                </span>
              </div>
            )}
          </div>
          <div className={styles.controls}>
            {!isCard && (
              <button
                className={styles.controlBtn}
                data-action="export"
                title={t('window.export')}
                aria-label={t('window.export')}
                onClick={() => exportContent(window.content, window.title, window.id)}
              >
                <ExportIcon />
              </button>
            )}
            <button
              className={styles.controlBtn}
              data-action="minimize"
              title={t('window.minimize')}
              aria-label={t('window.minimize')}
              onClick={() => useDesktopStore.getState().userMinimizeWindow(window.id)}
            >
              <MinimizeIcon />
            </button>
            {isCard && (
              <button
                className={styles.controlBtn}
                data-action="fullscreen"
                aria-pressed={isFullscreen}
                title={t(isFullscreen ? 'window.exitFullscreen' : 'window.fullscreen')}
                aria-label={t(isFullscreen ? 'window.exitFullscreen' : 'window.fullscreen')}
                onClick={() => {
                  // Tapping a card's button doesn't route through the frame's mousedown
                  // focus on every browser; fullscreen only holds for the focused card.
                  userFocusWindow(window.id);
                  useDesktopStore.getState().toggleFullscreenWindow(window.id);
                }}
              >
                {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
              </button>
            )}
            {!isCard && (
              <button
                className={styles.controlBtn}
                data-action="maximize"
                title={t(window.maximized ? 'window.restore' : 'window.maximize')}
                aria-label={t(window.maximized ? 'window.restore' : 'window.maximize')}
                onClick={() => {
                  useDesktopStore.getState().applyAction({
                    type: window.maximized ? 'window.restore' : 'window.maximize',
                    windowId: window.id,
                  });
                }}
              >
                {window.maximized ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
            )}
            <button
              className={styles.controlBtn}
              data-action="close"
              title={t('window.close')}
              aria-label={t('window.close')}
              onClick={() => userCloseWindow(window.id)}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      {/* Content area */}
      <div
        className={styles.content}
        data-window-content
        onMouseDown={(e) => {
          // Only when the press lands on the content box itself — its padding
          // ring, or the gap below the last component. Dragging from there has no
          // text node to anchor on, so Chrome selects the whole containing block.
          // Presses on actual children fall through and stay selectable.
          if (e.target === e.currentTarget) beginShellDrag(e);
        }}
        onContextMenu={(e) => {
          // If there's a text selection, show the selection action input
          const selectedText = globalThis.getSelection()?.toString().trim();
          if (selectedText) {
            e.preventDefault();
            setSelectionAction({ x: e.clientX, y: e.clientY, text: selectedText });
          }
        }}
      >
        <WindowCallbackProvider callbacks={windowCallbacks}>
          <RendererErrorBoundary>
            <MemoizedContentRenderer
              // Remount on reload. The key is what makes `window.reload` mean anything for
              // an iframe: same `src`, so React would otherwise reconcile it to the same
              // DOM node and the browser would never re-fetch.
              key={window.reloadNonce ?? 0}
              content={window.content}
              windowId={windowId}
              requestId={window.requestId}
              iframeToken={window.iframeToken}
              isolateOrigin={window.isolateOrigin}
              appOrigin={window.appOrigin}
              appId={window.appId}
            />
          </RendererErrorBoundary>
        </WindowCallbackProvider>
        {window.locked && <LockOverlay queuedCount={queuedCount} />}
        {/* A card is only ever seen when it is on top, so there is nothing to raise —
            the overlay would just eat the first tap. */}
        {!isFocused && !isCard && window.content.renderer === 'iframe' && (
          <div className={styles.iframeFocusOverlay} />
        )}
        {isDragOver && <div className={styles.dropOverlay} />}
        {selectionAction && (
          <SelectionActionInput
            x={selectionAction.x}
            y={selectionAction.y}
            selectedText={selectionAction.text}
            windowId={window.id}
            windowTitle={window.title}
            isRegion={false}
            onClose={() => setSelectionAction(null)}
          />
        )}
      </div>

      {/* Resize edges and corners */}
      {!window.maximized &&
        !isCard &&
        !isPanel &&
        !isFrameless &&
        (isWidget ? (
          /* Widget: SE corner handle only */
          <div className={styles.resizeSE} onMouseDown={(e) => handleResizeStart('se', e)} />
        ) : (
          <>
            <div className={styles.resizeN} onMouseDown={(e) => handleResizeStart('n', e)} />
            <div className={styles.resizeS} onMouseDown={(e) => handleResizeStart('s', e)} />
            <div className={styles.resizeW} onMouseDown={(e) => handleResizeStart('w', e)} />
            <div className={styles.resizeE} onMouseDown={(e) => handleResizeStart('e', e)} />
            <div className={styles.resizeNW} onMouseDown={(e) => handleResizeStart('nw', e)} />
            <div className={styles.resizeNE} onMouseDown={(e) => handleResizeStart('ne', e)} />
            <div className={styles.resizeSW} onMouseDown={(e) => handleResizeStart('sw', e)} />
            <div className={styles.resizeSE} onMouseDown={(e) => handleResizeStart('se', e)} />
          </>
        ))}

      {/* Keyed on the nonce so each change remounts it and replays the one-shot animation. */}
      {changeNonce !== mountChangeNonceRef.current && (
        <div key={changeNonce} className={styles.changeGlow} />
      )}

      <SnapPreview bounds={snapPreviewBounds} />
    </div>
  );
}

export const WindowFrame = memo(WindowFrameInner);
