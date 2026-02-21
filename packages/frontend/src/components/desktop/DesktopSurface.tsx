/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Drag/drop
 * - Rubber-band selection
 * - Keyboard shortcuts
 * - CSS var application
 * - Composition of sub-components
 */
import { useCallback, useEffect, useState, useRef } from 'react';
import { useDesktopStore, selectPanelWindows } from '@/store';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext';
import { filterImageFiles, uploadImages, uploadFiles, isExternalFileDrag } from '@/lib/uploadImage';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { WindowManager } from './WindowManager';
import { WindowFrame } from '../window/WindowFrame';
import { useShallow } from 'zustand/react/shallow';
import {
  ToastContainer,
  NotificationCenter,
  ConfirmDialog,
  UserPrompt,
  WindowContextMenu,
  CursorSpinner,
  CliPanel,
} from '../overlays';
import { CommandPalette } from '../command-palette/CommandPalette';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { resolveWallpaper, resolveAccent, resolveIconSize } from '@/constants/appearance';
import { DesktopStatusBar } from './DesktopStatusBar';
import { DesktopIcons } from './DesktopIcons';
import styles from '@/styles/desktop/DesktopSurface.module.css';

export function DesktopSurface() {
  const contextMenu = useDesktopStore((s) => s.contextMenu);
  const hideContextMenu = useDesktopStore((s) => s.hideContextMenu);
  const showContextMenu = useDesktopStore((s) => s.showContextMenu);
  const windowAgents = useDesktopStore((s) => s.windowAgents);
  const setSelectedWindows = useDesktopStore((s) => s.setSelectedWindows);
  const panelWindows = useDesktopStore(useShallow(selectPanelWindows));
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);
  const cliMode = useDesktopStore((s) => s.cliMode);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const wallpaper = useDesktopStore((s) => s.wallpaper);
  const accentColor = useDesktopStore((s) => s.accentColor);
  const iconSize = useDesktopStore((s) => s.iconSize);
  const {
    sendMessage,
    sendWindowMessage,
    sendComponentAction,
    sendToastAction,
    interruptAgent,
    interrupt,
  } = useAgentConnection({ autoConnect: false });

  // Rubber-band selection state
  const [selectionRect, setSelectionRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const selectionActive = useRef(false);
  const selectionListeners = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
  } | null>(null);

  // Clean up selection listeners on unmount
  useEffect(() => {
    return () => {
      if (selectionListeners.current) {
        document.removeEventListener('mousemove', selectionListeners.current.move);
        document.removeEventListener('mouseup', selectionListeners.current.up);
      }
    };
  }, []);

  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(new Set());

  // Global keyboard shortcuts: Shift+Tab for CLI mode, Ctrl+1..9 for monitors, Ctrl+W to close focused window
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        useDesktopStore.getState().toggleCliMode();
        return;
      }
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const mons = useDesktopStore.getState().monitors;
        if (idx < mons.length) {
          e.preventDefault();
          switchMonitor(mons[idx].id);
        }
      }
      // Ctrl+W: close the focused OS window (prevents browser tab close in --app mode)
      if (e.ctrlKey && e.key === 'w') {
        const { focusedWindowId: fwId, userCloseWindow } = useDesktopStore.getState();
        if (fwId) {
          e.preventDefault();
          userCloseWindow(fwId);
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [switchMonitor]);

  // Apply accent color to :root CSS vars
  useEffect(() => {
    const preset = resolveAccent(accentColor);
    if (preset) {
      document.documentElement.style.setProperty('--color-blue', preset.color);
      document.documentElement.style.setProperty('--color-blue-hover', preset.hover);
    }
  }, [accentColor]);

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      // Only handle clicks directly on the desktop
      if (e.target === e.currentTarget) {
        useDesktopStore.setState({ focusedWindowId: null });
        setSelectedWindows([]);
        setSelectedAppIds(new Set());
      }
      // Always close context menu on background click
      hideContextMenu();
    },
    [hideContextMenu, setSelectedWindows],
  );

  const handleBackgroundContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only handle right-clicks directly on the desktop background
      if (e.target === e.currentTarget) {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY);
      }
    },
    [showContextMenu],
  );

  // Image drop on desktop background
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const handleDesktopDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') && isExternalFileDrag()) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsImageDragOver(true);
    }
  }, []);
  const handleDesktopDragLeave = useCallback(() => {
    setIsImageDragOver(false);
  }, []);
  const handleDesktopDrop = useCallback((e: React.DragEvent) => {
    setIsImageDragOver(false);
    if (isExternalFileDrag() && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      const imageFiles = filterImageFiles(e.dataTransfer.files);
      const otherFiles = Array.from(e.dataTransfer.files).filter((f) => !imageFiles.includes(f));

      // Handle image files (existing behavior)
      if (imageFiles.length > 0) {
        uploadImages(imageFiles).then((paths) => {
          if (paths.length > 0) {
            const imageLines = paths.map((p) => `  image: ${p}`).join('\n');
            useDesktopStore
              .getState()
              .queueGestureMessage(`<ui:image_drop>\n${imageLines}\n</ui:image_drop>`);
          }
        });
      }

      // Handle non-image files — upload and notify AI
      if (otherFiles.length > 0) {
        uploadFiles(otherFiles).then((paths) => {
          if (paths.length > 0) {
            const fileLines = paths.map((p) => `  file: ${p}`).join('\n');
            useDesktopStore
              .getState()
              .queueGestureMessage(`<ui:file_drop>\n${fileLines}\n</ui:file_drop>`);
          }
        });
      }
    }
  }, []);

  const handleDesktopMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only start selection when clicking directly on the desktop background
      if (e.target !== e.currentTarget || e.button !== 0) return;

      e.preventDefault(); // Prevent text selection during rubberband drag

      const startX = e.clientX;
      const startY = e.clientY;
      selectionStart.current = { x: startX, y: startY };
      selectionActive.current = false;

      const DRAG_THRESHOLD = 5;

      const handleMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // Don't show rect until past threshold
        if (
          !selectionActive.current &&
          Math.abs(dx) < DRAG_THRESHOLD &&
          Math.abs(dy) < DRAG_THRESHOLD
        )
          return;
        selectionActive.current = true;

        const rect = {
          x: Math.min(startX, e.clientX),
          y: Math.min(startY, e.clientY),
          w: Math.abs(dx),
          h: Math.abs(dy),
        };
        setSelectionRect(rect);

        // Sample points on a grid within the rubberband and use elementFromPoint
        // to find only the TOPMOST window at each point (respects z-order).
        const STEP = 20;
        const windowIds = new Set<string>();
        const endX = rect.x + rect.w;
        const endY = rect.y + rect.h;
        for (let sx = rect.x; sx <= endX; sx += STEP) {
          for (let sy = rect.y; sy <= endY; sy += STEP) {
            const el = document.elementFromPoint(sx, sy);
            if (!el) continue;
            const winEl = (el as HTMLElement).closest<HTMLElement>(`[${WINDOW_ID_DATA_ATTR}]`);
            if (winEl && winEl.dataset.variant !== 'panel') {
              windowIds.add(winEl.dataset.windowId!);
            }
          }
        }
        // Always sample corners + center to catch edges the grid may skip
        for (const [sx, sy] of [
          [rect.x + rect.w / 2, rect.y + rect.h / 2],
          [endX, rect.y],
          [rect.x, endY],
          [endX, endY],
        ]) {
          const el = document.elementFromPoint(sx, sy);
          if (!el) continue;
          const winEl = (el as HTMLElement).closest<HTMLElement>(`[${WINDOW_ID_DATA_ATTR}]`);
          if (winEl && winEl.dataset.variant !== 'panel') {
            windowIds.add(winEl.dataset.windowId!);
          }
        }
        setSelectedWindows([...windowIds]);

        // Compute which app icons intersect
        const appIds = new Set<string>();
        document.querySelectorAll<HTMLElement>('[data-app-id]').forEach((el) => {
          const b = el.getBoundingClientRect();
          if (
            !(
              rect.x > b.right ||
              rect.x + rect.w < b.left ||
              rect.y > b.bottom ||
              rect.y + rect.h < b.top
            )
          ) {
            appIds.add(el.dataset.appId!);
          }
        });
        document.querySelectorAll<HTMLElement>('[data-shortcut-id]').forEach((el) => {
          const b = el.getBoundingClientRect();
          if (
            !(
              rect.x > b.right ||
              rect.x + rect.w < b.left ||
              rect.y > b.bottom ||
              rect.y + rect.h < b.top
            )
          ) {
            appIds.add(el.dataset.shortcutId!);
          }
        });
        setSelectedAppIds(appIds);
      };

      const handleMouseUp = () => {
        selectionStart.current = null;
        setSelectionRect(null);
        selectionActive.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        selectionListeners.current = null;
      };

      // Clean up any previous listeners (defensive)
      if (selectionListeners.current) {
        document.removeEventListener('mousemove', selectionListeners.current.move);
        document.removeEventListener('mouseup', selectionListeners.current.up);
      }
      selectionListeners.current = { move: handleMouseMove, up: handleMouseUp };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [setSelectedWindows],
  );

  const panelTopH = panelWindows.find((w) => w.dockEdge === 'top')?.bounds.h ?? 0;
  const panelBottomH =
    panelWindows.find((w) => (w.dockEdge ?? 'bottom') === 'bottom')?.bounds.h ?? 0;

  return (
    <>
      {/* CLI panel (behind desktop, slides in from left) */}
      {cliMode && <CliPanel />}

      <div
        className={styles.desktop}
        data-cli-mode={cliMode}
        style={
          {
            '--panel-top-h': `${panelTopH}px`,
            '--panel-bottom-h': `${panelBottomH}px`,
            background: resolveWallpaper(wallpaper),
            '--icon-size': `${resolveIconSize(iconSize).iconPx}px`,
            '--icon-label-max-width': `${resolveIconSize(iconSize).labelMaxWidth}px`,
            '--icon-grid-gap': `${resolveIconSize(iconSize).gridGap}px`,
          } as React.CSSProperties
        }
        data-image-dragover={isImageDragOver || undefined}
        onClick={handleBackgroundClick}
        onContextMenu={handleBackgroundContextMenu}
        onMouseDown={handleDesktopMouseDown}
        onDragOver={handleDesktopDragOver}
        onDragLeave={handleDesktopDragLeave}
        onDrop={handleDesktopDrop}
      >
        <DesktopStatusBar interrupt={interrupt} interruptAgent={interruptAgent} />

        <DesktopIcons
          selectedAppIds={selectedAppIds}
          sendMessage={sendMessage}
          showContextMenu={showContextMenu}
        />

        {/* Rubber-band selection rectangle */}
        {selectionRect && (
          <div
            className={styles.selectionRect}
            style={{
              left: selectionRect.x,
              top: selectionRect.y,
              width: selectionRect.w,
              height: selectionRect.h,
            }}
          />
        )}

        {/* Window container */}
        <QueueAwareComponentActionProvider sendComponentAction={sendComponentAction}>
          <WindowManager />
          {panelWindows.map((window) => (
            <WindowFrame
              key={window.id}
              window={window}
              zIndex={9000}
              isFocused={window.id === focusedWindowId}
            />
          ))}
        </QueueAwareComponentActionProvider>

        {/* Notification center (top-right) */}
        <NotificationCenter />

        {/* Window context menu */}
        {contextMenu && (
          <WindowContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            windowId={contextMenu.windowId}
            windowTitle={contextMenu.windowTitle}
            hasWindowAgent={
              contextMenu.windowId
                ? Object.values(windowAgents).some((wa) => wa.windowId === contextMenu.windowId)
                : false
            }
            onSend={sendMessage}
            onSendToWindow={sendWindowMessage}
            onClose={hideContextMenu}
          />
        )}

        {/* Cursor spinner when AI is thinking */}
        <CursorSpinner />
      </div>

      <DrawingOverlay />
      <CommandPalette />
      <ToastContainer onToastAction={sendToastAction} />
      <ConfirmDialog />
      <UserPrompt />
    </>
  );
}
