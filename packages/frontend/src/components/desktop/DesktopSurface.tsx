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
import { useDesktopStore, selectHasMaximizedWindow, selectPanelWindows } from '@/store';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext';
import { filterImageFiles, uploadImages, uploadFiles, isExternalFileDrag } from '@/lib/uploadImage';
import { runLocalToastAction } from '@/lib/localToastActions';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { WindowManager } from './WindowManager';
import { WindowFrame } from '../window/WindowFrame';
import { useShallow } from 'zustand/react/shallow';
import {
  ToastContainer,
  NotificationCenter,
  ConfirmDialog,
  UserPrompt,
  CursorSpinner,
  CliPanel,
} from '../overlays';
import { CommandPalette } from '../command-palette/CommandPalette';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { resolveWallpaper, resolveAccent, resolveIconSize } from '@/constants/appearance';
import { beginShellDrag } from '@/lib/selection';
import { DesktopStatusBar } from './DesktopStatusBar';
import { DesktopIcons } from './DesktopIcons';
import styles from '@/styles/desktop/DesktopSurface.module.css';

export function DesktopSurface() {
  const setSelectedWindows = useDesktopStore((s) => s.setSelectedWindows);
  const panelWindows = useDesktopStore(useShallow(selectPanelWindows));
  const hasMaximizedWindow = useDesktopStore(selectHasMaximizedWindow);
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);
  const cliMode = useDesktopStore((s) => s.cliMode);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const wallpaper = useDesktopStore((s) => s.wallpaper);
  const accentColor = useDesktopStore((s) => s.accentColor);
  const iconSize = useDesktopStore((s) => s.iconSize);
  const theme = useDesktopStore((s) => s.theme);
  const { sendMessage, sendComponentAction, sendToastAction, interruptAgent, interrupt } =
    useAgentConnection({ autoConnect: false });

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
  //
  // Capture phase, and each combo is claimed with stopImmediatePropagation(). These are
  // RESERVED_KEYBINDINGS (`@yaar/shared/app-protocol`), whose stated contract is that the
  // shell handles them before anything else does — a bubble-phase listener gave every
  // component in the tree first refusal instead. The iframe-side forwarder in
  // `iframe-scripts/contextmenu.ts` is capture-phase for the same reason.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const claim = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      // Block browser refresh shortcuts (F5, Ctrl+R)
      if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
        claim();
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        claim();
        useDesktopStore.getState().toggleCliMode();
        return;
      }
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const mons = useDesktopStore.getState().monitors;
        if (idx < mons.length) {
          claim();
          switchMonitor(mons[idx].id);
        }
      }
      // Ctrl+W: close the focused OS window (prevents browser tab close in --app mode)
      if (e.ctrlKey && e.key === 'w') {
        const { focusedWindowId: fwId, userCloseWindow } = useDesktopStore.getState();
        if (fwId) {
          claim();
          userCloseWindow(fwId);
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [switchMonitor]);

  // Forward keyboard shortcuts from focused iframes (they can't bubble to document)
  useEffect(() => {
    return iframeMessages.on('yaar:keydown', (ctx) => {
      const { key, shiftKey, ctrlKey } = ctx.data;
      // F5 / Ctrl+R from iframes — nothing to do (iframe can't refresh parent)
      if (key === 'F5' || (ctrlKey && key === 'r')) return;
      if (key === 'Tab' && shiftKey) {
        useDesktopStore.getState().toggleCliMode();
        return;
      }
      if (ctrlKey && key >= '1' && key <= '9') {
        const idx = parseInt(key) - 1;
        const mons = useDesktopStore.getState().monitors;
        if (idx < mons.length) switchMonitor(mons[idx].id);
      }
      if (ctrlKey && key === 'w') {
        const { focusedWindowId: fwId, userCloseWindow } = useDesktopStore.getState();
        if (fwId) userCloseWindow(fwId);
      }
    });
  }, [switchMonitor]);

  // Apply accent color to :root CSS vars
  useEffect(() => {
    const preset = resolveAccent(accentColor);
    if (preset) {
      const root = document.documentElement.style;
      root.setProperty('--color-accent', preset.color);
      root.setProperty('--color-accent-hover', preset.hover);
      // Filled buttons paint the emphasis pair, so it has to follow the preset too —
      // otherwise picking "pink" tints links but leaves every primary button blue.
      root.setProperty('--color-accent-emphasis', preset.emphasis);
      root.setProperty('--color-accent-emphasis-hover', preset.emphasisHover);
    }
  }, [accentColor]);

  // Apply theme — tokens.css keys its light overrides off :root[data-theme='light']
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      // Only handle clicks directly on the desktop
      if (e.target === e.currentTarget) {
        useDesktopStore.setState({ focusedWindowId: null });
        setSelectedWindows([]);
        setSelectedAppIds(new Set());
      }
    },
    [setSelectedWindows],
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

      // Prevent text selection during rubberband drag — and drop any live one,
      // since preventDefault would otherwise leave it stuck (see beginShellDrag).
      beginShellDrag(e);

      const startX = e.clientX;
      const startY = e.clientY;
      selectionStart.current = { x: startX, y: startY };
      selectionActive.current = false;

      const DRAG_THRESHOLD = 5;
      let rafId = 0;

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

        // Coalesce expensive DOM queries to one-per-frame
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
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
        });
      };

      const handleMouseUp = () => {
        cancelAnimationFrame(rafId);
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
        onMouseDown={handleDesktopMouseDown}
        onDragOver={handleDesktopDragOver}
        onDragLeave={handleDesktopDragLeave}
        onDrop={handleDesktopDrop}
      >
        <div hidden={hasMaximizedWindow}>
          <DesktopStatusBar interrupt={interrupt} interruptAgent={interruptAgent} />
        </div>

        <DesktopIcons selectedAppIds={selectedAppIds} sendMessage={sendMessage} />

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

        {/* Cursor spinner when AI is thinking */}
        <CursorSpinner />
      </div>

      <DrawingOverlay />
      <div hidden={hasMaximizedWindow}>
        <CommandPalette />
      </div>
      {/* Frontend-raised toasts (e.g. "Retry" on a failed app launch) carry no
          server-side event, so try the local registry before the WebSocket. */}
      <ToastContainer
        onToastAction={(toastId, eventId) => {
          if (!runLocalToastAction(eventId)) sendToastAction(toastId, eventId);
        }}
      />
      <ConfirmDialog />
      <UserPrompt />
    </>
  );
}
