/**
 * WindowFrame - Draggable, resizable window container.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopStore, selectQueuedActionsCount, selectWindowAgent } from '@/store';
import {
  tryIframeSelfCapture,
  getIframeDragSource,
  consumeIframeDragSource,
} from '@/store/desktop';
import { getRawWindowId } from '@/store/helpers';
import { useComponentAction } from '@/contexts/ComponentActionContext';
import type { WindowModel } from '@/types/state';
import { MemoizedContentRenderer } from './ContentRenderer';
import { LockOverlay } from './LockOverlay';
import { filterImageFiles, uploadImages, isExternalFileDrag } from '@/lib/uploadImage';
import styles from '@/styles/windows/WindowFrame.module.css';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[/\\?%*:|"<>]/g, '-');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportContent(content: WindowModel['content'], title: string, windowId?: string) {
  const { renderer, data } = content;
  let blob: Blob;
  let filename: string;

  switch (renderer) {
    case 'markdown':
    case 'text':
      blob = new Blob([String(data)], { type: 'text/plain' });
      filename = `${title}.${renderer === 'markdown' ? 'md' : 'txt'}`;
      break;
    case 'html':
      blob = new Blob([String(data)], { type: 'text/html' });
      filename = `${title}.html`;
      break;
    case 'table': {
      const tableData = data as { headers?: string[]; rows?: unknown[][] };
      if (tableData.headers && tableData.rows) {
        const csv = [
          tableData.headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(','),
          ...tableData.rows.map((row) =>
            row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
          ),
        ].join('\n');
        blob = new Blob([csv], { type: 'text/csv' });
        filename = `${title}.csv`;
      } else {
        blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        filename = `${title}.json`;
      }
      break;
    }
    case 'iframe': {
      // Three-tier iframe export: same-origin HTML → screenshot → URL fallback
      if (windowId) {
        const el = document.querySelector(
          `[data-window-id="${windowId}"] iframe`,
        ) as HTMLIFrameElement | null;
        if (el) {
          // Tier 1: Same-origin HTML export
          try {
            const doc = el.contentDocument;
            if (doc) {
              const html = doc.documentElement.outerHTML;
              triggerDownload(new Blob([html], { type: 'text/html' }), `${title}.html`);
              return;
            }
          } catch {
            /* cross-origin — fall through */
          }

          // Tier 2: Screenshot via self-capture protocol
          if (el.contentWindow) {
            const imageData = await tryIframeSelfCapture(el);
            if (imageData) {
              const res = await fetch(imageData);
              const pngBlob = await res.blob();
              triggerDownload(pngBlob, `${title}.png`);
              return;
            }
          }
        }
      }

      // Tier 3: URL fallback
      const iframeData = data as { url?: string } | string;
      const url = typeof iframeData === 'string' ? iframeData : iframeData?.url;
      blob = new Blob([url || ''], { type: 'text/plain' });
      filename = `${title}-url.txt`;
      break;
    }
    default:
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      filename = `${title}.json`;
  }

  triggerDownload(blob, filename);
}

/**
 * Extract visible text content from DOM elements that fall within a given viewport rect.
 */
function extractTextInRegion(
  container: HTMLElement,
  rect: { x: number; y: number; w: number; h: number },
): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    for (const r of rects) {
      // Check intersection
      if (
        r.right > rect.x &&
        r.left < rect.x + rect.w &&
        r.bottom > rect.y &&
        r.top < rect.y + rect.h
      ) {
        const text = node.textContent?.trim();
        if (text) parts.push(text);
        break;
      }
    }
  }
  return parts.join(' ').slice(0, 2000); // Limit length
}

/**
 * Floating input that appears on right-click with selected text or after region select.
 * User types an instruction for the AI to execute on the selection.
 */
function SelectionActionInput({
  x,
  y,
  selectedText,
  windowId,
  windowTitle,
  isRegion,
  onClose,
}: {
  x: number;
  y: number;
  selectedText: string;
  windowId: string;
  windowTitle: string;
  isRegion: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleClickOutside = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the right-click event
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleSubmit = useCallback(
    (instruction: string) => {
      if (!instruction.trim()) return;
      const rawId = getRawWindowId(windowId);
      const tag = isRegion && !selectedText ? 'region_select' : 'selection';
      const textPart = selectedText ? `\n  selected_text: "${selectedText.slice(0, 1000)}"` : '';
      useDesktopStore
        .getState()
        .queueGestureMessage(
          `<user_interaction:${tag}>\n  instruction: "${instruction}"${textPart}\n  source: window "${windowTitle}" (id: ${rawId})\n</user_interaction:${tag}>`,
        );
      onClose();
    },
    [windowId, windowTitle, selectedText, isRegion, onClose],
  );

  // Position the input near the cursor but keep it within viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, globalThis.innerWidth - 320),
    top: Math.min(y + 4, globalThis.innerHeight - 40),
    zIndex: 99999,
  };

  return (
    <div className={styles.selectionActionInput} style={style}>
      <input
        ref={inputRef}
        type="text"
        className={styles.selectionInput}
        placeholder={
          selectedText ? 'What to do with selection...' : 'What to do with this region...'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleSubmit((e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            onClose();
          }
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

interface WindowFrameProps {
  window: WindowModel;
  zIndex: number;
  isFocused: boolean;
}

function WindowFrameInner({ window, zIndex, isFocused }: WindowFrameProps) {
  const variant = window.variant ?? 'standard';
  const isWidget = variant === 'widget';
  const isPanel = variant === 'panel';
  const isFrameless = !!window.frameless;
  // Subscribe to individual stable action refs — never triggers re-renders
  const userFocusWindow = useDesktopStore((s) => s.userFocusWindow);
  const userCloseWindow = useDesktopStore((s) => s.userCloseWindow);
  const userMoveWindow = useDesktopStore((s) => s.userMoveWindow);
  const userResizeWindow = useDesktopStore((s) => s.userResizeWindow);
  const queueBoundsUpdate = useDesktopStore((s) => s.queueBoundsUpdate);
  const showContextMenu = useDesktopStore((s) => s.showContextMenu);
  const queuedCount = useDesktopStore(selectQueuedActionsCount(window.id));
  const windowAgent = useDesktopStore(selectWindowAgent(window.id));
  const isSelected = useDesktopStore((s) => s.selectedWindowIds.includes(window.id));
  const sendComponentAction = useComponentAction();

  const handleComponentAction = useCallback(
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

  // Drag-over state for app icon / iframe text / image file drop target
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes('application/x-yaar-app') ||
      getIframeDragSource() ||
      (e.dataTransfer.types.includes('Files') && isExternalFileDrag())
    ) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-yaar-app')
        ? 'link'
        : 'copy';
      setIsDragOver(true);
    }
  }, []);
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      // Focus the window when text is dragged over it from an iframe
      if (getIframeDragSource()) {
        e.preventDefault();
        userFocusWindow(window.id);
      }
    },
    [userFocusWindow, window.id],
  );
  const handleDragLeave = useCallback(() => setIsDragOver(false), []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setIsDragOver(false);

      // App icon drop
      const appId = e.dataTransfer.getData('application/x-yaar-app');
      if (appId) {
        e.preventDefault();
        const rawId = getRawWindowId(window.id);
        useDesktopStore
          .getState()
          .queueGestureMessage(
            `<user_interaction:drag>app "${appId}" dragged onto window "${window.title}" (id: ${rawId})</user_interaction:drag>`,
          );
        return;
      }

      // Iframe text drag → drop onto this window
      const dragSource = consumeIframeDragSource();
      if (dragSource) {
        e.preventDefault();
        const store = useDesktopStore.getState();
        const sourceWin = store.windows[dragSource.windowId];
        const sourceTitle = sourceWin?.title ?? dragSource.windowId;
        const sourceRawId = getRawWindowId(dragSource.windowId);
        const targetRawId = getRawWindowId(window.id);
        store.queueGestureMessage(
          `<user_interaction:select>\n  selected_text: "${dragSource.text.slice(0, 1000)}"\n  source: window "${sourceTitle}" (id: ${sourceRawId})\n</user_interaction:select>\n<user_interaction:drag>\n  target: window "${window.title}" (id: ${targetRawId})\n</user_interaction:drag>`,
        );
        return;
      }

      // Image file drop (only external drags from file manager, not in-page img drags)
      if (isExternalFileDrag() && e.dataTransfer.files.length > 0) {
        const imageFiles = filterImageFiles(e.dataTransfer.files);
        if (imageFiles.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const rawId = getRawWindowId(window.id);
          uploadImages(imageFiles).then((paths) => {
            if (paths.length > 0) {
              const imageLines = paths.map((p) => `  image: ${p}`).join('\n');
              useDesktopStore
                .getState()
                .queueGestureMessage(
                  `<user_interaction:image_drop>\n${imageLines}\n  source: window "${window.title}" (id: ${rawId})\n</user_interaction:image_drop>`,
                );
            }
          });
        }
      }
    },
    [window.id, window.title],
  );

  // Selection action input state
  const [selectionAction, setSelectionAction] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  // Region select state (right-click drag)
  const [regionRect, setRegionRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const regionStart = useRef<{ x: number; y: number } | null>(null);
  const regionActive = useRef(false);
  const regionListeners = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
  } | null>(null);

  const frameRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
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
      if (regionListeners.current) {
        document.removeEventListener('mousemove', regionListeners.current.move);
        document.removeEventListener('mouseup', regionListeners.current.up);
        regionListeners.current = null;
      }
    };
  }, []);

  // Handle window focus
  const handleMouseDown = useCallback(() => {
    userFocusWindow(window.id);
  }, [userFocusWindow, window.id]);

  // Handle title bar drag (also used for widget body drag)
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return;
      if ((e.target as HTMLElement).closest(`.${styles.widgetClose}`)) return;

      e.preventDefault();
      setIsDragging(true);
      document.documentElement.classList.add('yaar-dragging');
      dragOffset.current = {
        x: e.clientX - window.bounds.x,
        y: e.clientY - window.bounds.y,
      };

      const TITLEBAR_H = 36;
      const TASKBAR_H = 36;
      const winVariant = window.variant;
      const yClamp = !winVariant || winVariant === 'standard' ? TITLEBAR_H : 0;

      const handleMouseMove = (e: MouseEvent) => {
        const vw = globalThis.innerWidth;
        const vh = globalThis.innerHeight;

        let newX = e.clientX - dragOffset.current.x;
        let newY = e.clientY - dragOffset.current.y;

        // Keep title bar reachable: at least 100px of width visible horizontally
        newX = Math.max(-(window.bounds.w - 100), Math.min(newX, vw - 100));
        // Top: can't go above viewport; Bottom: title bar must stay above taskbar
        newY = Math.max(0, Math.min(newY, vh - TASKBAR_H - yClamp));

        userMoveWindow(window.id, newX, newY);
      };

      const entry = { move: handleMouseMove, up: handleMouseUp };
      function handleMouseUp() {
        setIsDragging(false);
        document.documentElement.classList.remove('yaar-dragging');
        queueBoundsUpdate(window.id);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        listenersRef.current = listenersRef.current.filter((e) => e !== entry);
      }

      listenersRef.current.push(entry);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [
      window.id,
      window.bounds.x,
      window.bounds.y,
      window.bounds.w,
      window.variant,
      userMoveWindow,
      queueBoundsUpdate,
    ],
  );

  // Widget drag: combines focus + drag on frame mousedown
  const handleWidgetDragStart = useCallback(
    (e: React.MouseEvent) => {
      userFocusWindow(window.id);
      handleDragStart(e);
    },
    [userFocusWindow, window.id, handleDragStart],
  );

  // Handle resize from any edge/corner
  const handleResizeStart = useCallback(
    (direction: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      document.documentElement.classList.add('yaar-dragging');

      const startBounds = { ...window.bounds };
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;

      const resizeTop = direction.includes('n');
      const resizeBottom = direction.includes('s');
      const resizeLeft = direction.includes('w');
      const resizeRight = direction.includes('e');

      const TASKBAR_H = 36;

      const handleMouseMove = (e: MouseEvent) => {
        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;
        const vh = globalThis.innerHeight;
        const vw = globalThis.innerWidth;

        let newX = startBounds.x;
        let newY = startBounds.y;
        let newW = startBounds.w;
        let newH = startBounds.h;

        if (resizeRight) newW = startBounds.w + dx;
        if (resizeLeft) {
          newW = startBounds.w - dx;
          newX = startBounds.x + dx;
        }
        if (resizeBottom) newH = startBounds.h + dy;
        if (resizeTop) {
          newH = startBounds.h - dy;
          newY = startBounds.y + dy;
        }

        // Enforce minimums
        if (newW < 200) {
          if (resizeLeft) newX = startBounds.x + startBounds.w - 200;
          newW = 200;
        }
        if (newH < 150) {
          if (resizeTop) newY = startBounds.y + startBounds.h - 150;
          newH = 150;
        }

        // Clamp: top edge can't go above viewport
        if (newY < 0) {
          newH += newY;
          newY = 0;
        }
        // Clamp: bottom edge can't go below viewport minus taskbar
        const maxH = vh - TASKBAR_H - newY;
        if (newH > maxH) newH = maxH;
        // Clamp: right edge within viewport
        if (newX + newW > vw) newW = vw - newX;
        // Clamp: left edge within viewport
        if (newX < 0) {
          newW += newX;
          newX = 0;
        }

        // Re-enforce minimums after clamping
        if (newW < 200) newW = 200;
        if (newH < 150) newH = 150;

        const posChanged = resizeLeft || resizeTop;
        userResizeWindow(
          window.id,
          newW,
          newH,
          posChanged ? newX : undefined,
          posChanged ? newY : undefined,
        );
      };

      const entry = { move: handleMouseMove, up: handleMouseUp };
      function handleMouseUp() {
        setIsResizing(false);
        document.documentElement.classList.remove('yaar-dragging');
        queueBoundsUpdate(window.id);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        listenersRef.current = listenersRef.current.filter((e) => e !== entry);
      }

      listenersRef.current.push(entry);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [window.id, window.bounds, userResizeWindow, queueBoundsUpdate],
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
          onMouseDown={handleDragStart}
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
                title={`Locked by: ${window.lockedBy || 'unknown'}`}
              >
                <span className={styles.lockIcon}>🔒</span>
              </div>
            )}
            {windowAgent && (
              <div
                className={styles.agentBadge}
                data-status={windowAgent.status}
                title={`Pool agent: ${windowAgent.agentId} (${windowAgent.status})`}
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
              title="Export content"
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
          // If right-drag region is active, suppress context menu
          if (regionActive.current) {
            e.preventDefault();
            return;
          }
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
        onMouseDown={(e) => {
          // Right-click drag for region selection
          if (e.button === 2) {
            const contentEl = e.currentTarget;
            const contentRect = contentEl.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            regionStart.current = { x: startX, y: startY };
            regionActive.current = false;

            const DRAG_THRESHOLD = 5;

            const handleMouseMove = (ev: MouseEvent) => {
              const dx = ev.clientX - startX;
              const dy = ev.clientY - startY;
              if (
                !regionActive.current &&
                Math.abs(dx) < DRAG_THRESHOLD &&
                Math.abs(dy) < DRAG_THRESHOLD
              )
                return;
              regionActive.current = true;

              setRegionRect({
                x: Math.min(startX, ev.clientX) - contentRect.left,
                y: Math.min(startY, ev.clientY) - contentRect.top,
                w: Math.abs(dx),
                h: Math.abs(dy),
              });
            };

            const handleMouseUp = (ev: MouseEvent) => {
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
              regionListeners.current = null;

              if (regionActive.current) {
                const hint = extractTextInRegion(contentEl, {
                  x: Math.min(startX, ev.clientX),
                  y: Math.min(startY, ev.clientY),
                  w: Math.abs(ev.clientX - startX),
                  h: Math.abs(ev.clientY - startY),
                });
                setRegionRect(null);
                setSelectionAction({
                  x: ev.clientX,
                  y: ev.clientY,
                  text: hint || '',
                });
              }
              regionActive.current = false;
            };

            // Clean up previous listeners
            if (regionListeners.current) {
              document.removeEventListener('mousemove', regionListeners.current.move);
              document.removeEventListener('mouseup', regionListeners.current.up);
            }
            regionListeners.current = { move: handleMouseMove, up: handleMouseUp };
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          }
        }}
      >
        <MemoizedContentRenderer
          content={window.content}
          windowId={windowId}
          requestId={window.requestId}
          onRenderSuccess={onRenderSuccess}
          onRenderError={onRenderError}
          onComponentAction={handleComponentAction}
        />
        {window.locked && <LockOverlay queuedCount={queuedCount} />}
        {!isFocused && window.content.renderer === 'iframe' && (
          <div className={styles.iframeFocusOverlay} />
        )}
        {isDragOver && <div className={styles.dropOverlay} />}
        {regionRect && (
          <div
            className={styles.regionRect}
            style={{
              left: regionRect.x,
              top: regionRect.y,
              width: regionRect.w,
              height: regionRect.h,
            }}
          />
        )}
        {selectionAction && (
          <SelectionActionInput
            x={selectionAction.x}
            y={selectionAction.y}
            selectedText={selectionAction.text}
            windowId={window.id}
            windowTitle={window.title}
            isRegion={!selectionAction.text && regionRect === null}
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
    </div>
  );
}

export const WindowFrame = memo(WindowFrameInner);
