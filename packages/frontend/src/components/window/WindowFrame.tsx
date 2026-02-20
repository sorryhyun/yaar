/**
 * WindowFrame - Draggable, resizable window container.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore, selectQueuedActionsCount, selectWindowAgent } from '@/store';
import { useComponentAction } from '@/contexts/ComponentActionContext';
import { WindowCallbackProvider } from '@/contexts/WindowCallbackContext';
import type { WindowModel } from '@/types/state';
import { MemoizedContentRenderer } from './ContentRenderer';
import { LockOverlay } from './LockOverlay';
import { SnapPreview } from './SnapPreview';
import { SelectionActionInput } from './SelectionActionInput';
import { exportContent } from '@/lib/exportContent';
import { useDragWindow } from '@/hooks/useDragWindow';
import { useResizeWindow } from '@/hooks/useResizeWindow';
import { useWindowDrop } from '@/hooks/useWindowDrop';
import styles from '@/styles/window/WindowFrame.module.css';

interface WindowFrameProps {
  window: WindowModel;
  zIndex: number;
  isFocused: boolean;
  hidden?: boolean;
}

function WindowFrameInner({ window, zIndex, isFocused, hidden }: WindowFrameProps) {
  const { t } = useTranslation();
  const variant = window.variant ?? 'standard';
  const isWidget = variant === 'widget';
  const isPanel = variant === 'panel';
  const isFrameless = !!window.frameless;

  // Subscribe to individual stable action refs — never triggers re-renders
  const userFocusWindow = useDesktopStore((s) => s.userFocusWindow);
  const userCloseWindow = useDesktopStore((s) => s.userCloseWindow);
  const showContextMenu = useDesktopStore((s) => s.showContextMenu);
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

  const frameRef = useRef<HTMLDivElement>(null);
  const listenersRef = useRef<
    Array<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void }>
  >([]);

  // Cleanup document listeners on unmount to prevent leaks
  useEffect(() => {
    return () => {
      for (const { move, up } of listenersRef.current) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      listenersRef.current = [];
    };
  }, []);

  // --- Extracted hooks ---
  const { isDragging, snapPreviewBounds, handleDragStart } = useDragWindow({
    windowId: window.id,
    bounds: window.bounds,
    variant: window.variant,
    frameless: window.frameless,
    listenersRef,
  });

  const { isResizing, handleResizeStart } = useResizeWindow({
    windowId: window.id,
    bounds: window.bounds,
    listenersRef,
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
      if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return;
      if ((e.target as HTMLElement).closest(`.${styles.widgetClose}`)) return;
      handleDragStart(e);
    },
    [handleDragStart],
  );

  // Widget drag: combines focus + drag on frame mousedown
  const handleWidgetDragStart = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(`.${styles.widgetClose}`)) return;
      userFocusWindow(window.id);
      handleDragStart(e);
    },
    [userFocusWindow, window.id, handleDragStart],
  );

  // Determine position/size (handle maximized state and variants)
  let style: React.CSSProperties;
  if (window.windowStyle) {
    // Custom CSS positioning from app.json windowStyle
    style = {
      width: window.bounds.w,
      height: window.bounds.h,
      zIndex: isPanel ? 9000 : zIndex + 100,
      ...window.windowStyle,
    };
  } else if (isPanel) {
    const edge = window.dockEdge ?? 'bottom';
    style = {
      position: 'fixed',
      left: 0,
      width: '100%',
      height: window.bounds.h,
      zIndex: 9000,
      ...(edge === 'top' ? { top: 0 } : { bottom: 0 }),
    };
  } else if (window.maximized) {
    style = {
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: zIndex + 100,
    };
  } else if (isWidget) {
    style = {
      top: window.bounds.y,
      left: window.bounds.x,
      width: window.bounds.w,
      height: window.bounds.h,
      zIndex, // No +100 offset — keeps widgets below standard windows
    };
  } else {
    style = {
      top: window.bounds.y,
      left: window.bounds.x,
      width: window.bounds.w,
      height: window.bounds.h,
      zIndex: zIndex + 100,
    };
  }

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={style}
      data-window-id={window.id}
      data-variant={variant}
      data-frameless={isFrameless || undefined}
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

      {/* Title bar — standard variant only (hidden for frameless) */}
      {!isWidget && !isPanel && !isFrameless && (
        <div
          className={styles.titleBar}
          onMouseDown={handleTitleBarDragStart}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, window.id);
          }}
        >
          <div className={styles.titleSection}>
            <div className={styles.title}>{window.title}</div>
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
            <button
              className={styles.controlBtn}
              data-action="export"
              title={t('window.export')}
              onClick={() => exportContent(window.content, window.title, window.id)}
            >
              ↑
            </button>
            <button
              className={styles.controlBtn}
              data-action="minimize"
              onClick={() => {
                useDesktopStore.getState().applyAction({
                  type: 'window.minimize',
                  windowId: window.id,
                });
              }}
            >
              −
            </button>
            <button
              className={styles.controlBtn}
              data-action="maximize"
              onClick={() => {
                useDesktopStore.getState().applyAction({
                  type: window.maximized ? 'window.restore' : 'window.maximize',
                  windowId: window.id,
                });
              }}
            >
              □
            </button>
            <button
              className={styles.controlBtn}
              data-action="close"
              onClick={() => userCloseWindow(window.id)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Content area */}
      <div
        className={styles.content}
        onContextMenu={(e) => {
          // If there's a text selection, show the selection action input
          const selectedText = globalThis.getSelection()?.toString().trim();
          if (selectedText) {
            e.preventDefault();
            setSelectionAction({ x: e.clientX, y: e.clientY, text: selectedText });
            return;
          }
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, window.id);
        }}
      >
        <WindowCallbackProvider callbacks={windowCallbacks}>
          <MemoizedContentRenderer
            content={window.content}
            windowId={windowId}
            requestId={window.requestId}
          />
        </WindowCallbackProvider>
        {window.locked && <LockOverlay queuedCount={queuedCount} />}
        {!isFocused && window.content.renderer === 'iframe' && (
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

      <SnapPreview bounds={snapPreviewBounds} />
    </div>
  );
}

export const WindowFrame = memo(WindowFrameInner);
