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
import {
  useDesktopStore,
  selectHasMaximizedWindow,
  selectFullscreenCardId,
  selectPanelWindows,
} from '@/store';
import {
  useAgentConnectionOwner,
  sendMessage,
  sendComponentAction,
  sendToastAction,
  interruptAgent,
  interrupt,
} from '@/hooks/useAgentConnection';
import { useFormFactorSync } from '@/hooks/useFormFactorSync';
import { usePhoneBack } from '@/hooks/usePhoneBack';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext';
import { filterImageFiles, uploadImages, uploadFiles, isExternalFileDrag } from '@/lib/uploadImage';
import { runLocalToastAction } from '@/lib/localToastActions';
import {
  editableHoldsText,
  isCloseWindowShortcut,
  monitorStepDirection,
  resolveCloseTopWindow,
  resolveMonitorStep,
  shouldConfirmUnload,
} from '@/lib/shellShortcuts';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { WindowManager } from './WindowManager';
import { WindowFrame } from '../window/WindowFrame';
import { useShallow } from 'zustand/react/shallow';
import {
  ToastContainer,
  NotificationCenter,
  NotificationShade,
  ConfirmDialog,
  UserPrompt,
  CursorSpinner,
  CliPanel,
} from '../overlays';
import { CommandPalette } from '../command-palette/CommandPalette';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { resolveWallpaper, resolveAccent, resolveIconSize } from '@/constants/appearance';
import { beginShellDrag } from '@/lib/selection';
import { DesktopStatusBar, PhoneStatusBadge } from './DesktopStatusBar';
import { DesktopIcons } from './DesktopIcons';
import { PhoneGestures } from './PhoneGestures';
import styles from '@/styles/desktop/DesktopSurface.module.css';

/** Whether `list` holds exactly the members of `set` — the rubber band's no-op check. */
function sameMembers(list: readonly string[], set: ReadonlySet<string>): boolean {
  return list.length === set.size && list.every((id) => set.has(id));
}

/**
 * Shift+Left/Right: one step along the monitor strip, or a new monitor off its right end.
 * The server mints that one and switches this tab to it on its `MONITORS` answer.
 */
function stepMonitor(delta: -1 | 1) {
  const state = useDesktopStore.getState();
  const target = resolveMonitorStep(state, delta);
  if (target?.kind === 'new') state.createMonitor();
  else if (target) state.switchMonitor(target.id);
}

export function DesktopSurface() {
  const setSelectedWindows = useDesktopStore((s) => s.setSelectedWindows);
  const panelWindows = useDesktopStore(useShallow(selectPanelWindows));
  const hasMaximizedWindow = useDesktopStore(selectHasMaximizedWindow);
  const hasFullscreenCard = useDesktopStore((s) => selectFullscreenCardId(s) !== null);
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);
  const cliMode = useDesktopStore((s) => s.cliMode);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const wallpaper = useDesktopStore((s) => s.wallpaper);
  const accentColor = useDesktopStore((s) => s.accentColor);
  const iconSize = useDesktopStore((s) => s.iconSize);
  const theme = useDesktopStore((s) => s.theme);
  useAgentConnectionOwner();
  useFormFactorSync();
  usePhoneBack();

  // Rubber-band selection. The rectangle is presentational, so it is written straight to
  // the DOM node as CSS vars and never through React: a state write per mousemove re-ran
  // this whole subtree — CommandPalette and DesktopIcons included — at pointer rate. The
  // selection it produces still goes through state, but only once per frame and only
  // when it actually changed.
  const selectionRectEl = useRef<HTMLDivElement>(null);
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

  // Global keyboard shortcuts: Shift+Tab for CLI mode, Ctrl+1..9 for monitors, Ctrl+W to
  // close the topmost window.
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
      // Ctrl+W closes the topmost OS window. Claimed before we know whether there is one
      // to close: unclaimed, Chrome takes it and closes the YAAR window itself, so an
      // empty desktop is exactly when *not* claiming does the most damage.
      if (isCloseWindowShortcut(e)) {
        claim();
        const state = useDesktopStore.getState();
        const target = resolveCloseTopWindow(state);
        if (target) state.userCloseWindow(target);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [switchMonitor]);

  // Shift+Left/Right steps along the monitor strip, making a new monitor off the right
  // end — the keyboard half of the phone's sideways pan. Unlike the combos above this one
  // is *not* reserved: text fields and apps use Shift+Arrow for selection, so it is a
  // bubble-phase listener on `window` that only acts on a keystroke nobody else took
  // (`defaultPrevented`) and that is not selecting text in a field (`editableHoldsText`).
  // Key repeat is ignored so holding the key cannot mint monitors until the session fills.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      const delta = monitorStepDirection(e);
      if (delta === null || editableHoldsText(e.target)) return;
      e.preventDefault();
      stepMonitor(delta);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ⌘W (and Ctrl+W on a browser build that keeps the accelerator) can't be cancelled
  // from the page — see shouldConfirmUnload. A beforeunload handler is the one thing
  // browsers still honour: it can't stop the close, only make Chrome ask first, and
  // only after the user has interacted with the page (sticky activation). The dialog
  // text is Chrome's own; `returnValue` is set for the browsers that still require it.
  //
  // Registered unconditionally and gated inside the handler, so it reads live store
  // state rather than re-subscribing on every window open and close.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!shouldConfirmUnload(useDesktopStore.getState())) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Forward keyboard shortcuts from focused iframes (they can't bubble to document)
  useEffect(() => {
    return iframeMessages.on('yaar:keydown', (ctx) => {
      const { key, shiftKey, ctrlKey, altKey, metaKey } = ctx.data;
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
      // Forwarded only once the app has let the keystroke go by (see the contextmenu
      // script), so here it is simply ours.
      const delta = monitorStepDirection({ key, shiftKey, ctrlKey, altKey: !!altKey, metaKey });
      if (delta !== null) {
        stepMonitor(delta);
        return;
      }
      // The iframe script already called preventDefault() on its side, so the browser
      // window is safe whatever we decide here.
      if (isCloseWindowShortcut({ key, ctrlKey, shiftKey, altKey: !!altKey })) {
        const state = useDesktopStore.getState();
        const target = resolveCloseTopWindow(state);
        if (target) state.userCloseWindow(target);
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

  // Which top corner the phone's status badge takes; a card's title bar keys the side it
  // leaves room on off :root[data-handedness] (WindowFrame.module.css).
  const handedness = useDesktopStore((s) => s.handedness);
  useEffect(() => {
    document.documentElement.dataset.handedness = handedness;
  }, [handedness]);

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
        const el = selectionRectEl.current;
        if (el) {
          el.style.setProperty('--sel-x', `${rect.x}px`);
          el.style.setProperty('--sel-y', `${rect.y}px`);
          el.style.setProperty('--sel-w', `${rect.w}px`);
          el.style.setProperty('--sel-h', `${rect.h}px`);
          el.hidden = false;
        }

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
          if (!sameMembers(useDesktopStore.getState().selectedWindowIds, windowIds)) {
            setSelectedWindows([...windowIds]);
          }

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
          setSelectedAppIds((prev) => (sameMembers([...prev], appIds) ? prev : appIds));
        });
      };

      const handleMouseUp = () => {
        cancelAnimationFrame(rafId);
        selectionStart.current = null;
        if (selectionRectEl.current) selectionRectEl.current.hidden = true;
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
        data-gesture-layer="monitor-peek"
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
        <div ref={selectionRectEl} className={styles.selectionRect} hidden />

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

        {/* Notification center (top-right) — the phone shows the same notifications in
            a pull-down shade instead, outside the desktop so a card cannot cover it. */}
        <NotificationCenter />

        {/* Cursor spinner when AI is thinking */}
        <CursorSpinner />
      </div>

      {/* The phone's status surface as well as its notifications — the pull-down is
          where the connection and agent readings live there. */}
      <NotificationShade interrupt={interrupt} />
      {/* Edge gestures: swipe in from the side to change monitor, pull down for the
          shade. Above the desktop so the gutters sit over the cards they have to
          catch touches in front of. */}
      <PhoneGestures />
      {/* The phone's status badge, over everything — outside the desktop so no card
          covers it and no pan slides it. The CLI has its own monitor bar. */}
      {isMobile && !cliMode && <PhoneStatusBadge />}

      <DrawingOverlay />
      {/* A phone keeps the palette under every window — it is the only way to talk to the
          agent, and there is no desktop edge to reach it from — unless the user put the top
          card in full screen, whose title bar button is the way back. */}
      <div hidden={isMobile ? hasFullscreenCard : hasMaximizedWindow}>
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
