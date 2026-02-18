/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Contains all windows
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useDesktopStore, selectPanelWindows } from '@/store';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import { filterImageFiles, uploadImages, uploadFiles, isExternalFileDrag } from '@/lib/uploadImage';
import type { DesktopShortcut } from '@yaar/shared';
import { getRawWindowId } from '@/store/helpers';
import { WindowManager } from './WindowManager';
import { WindowFrame } from '../windows/WindowFrame';
import { useShallow } from 'zustand/react/shallow';
import { ToastContainer } from '../ui/ToastContainer';
import { NotificationCenter } from '../ui/NotificationCenter';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { UserPrompt } from '../ui/UserPrompt';
import { CommandPalette } from '../ui/CommandPalette';
import { WindowContextMenu } from '../ui/WindowContextMenu';
import { CursorSpinner } from '../ui/CursorSpinner';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { CliPanel } from '../ui/CliPanel';
import { resolveWallpaper, resolveAccent, resolveIconSize } from '@/constants/appearance';
import styles from '@/styles/desktop/DesktopSurface.module.css';

/** App info from /api/apps endpoint */
interface AppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  hasSkill: boolean;
  hasCredentials: boolean;
  hidden?: boolean;
}

export function DesktopSurface() {
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const providerType = useDesktopStore((s) => s.providerType);
  const contextMenu = useDesktopStore((s) => s.contextMenu);
  const hideContextMenu = useDesktopStore((s) => s.hideContextMenu);
  const showContextMenu = useDesktopStore((s) => s.showContextMenu);
  const windowAgents = useDesktopStore((s) => s.windowAgents);
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  const agentPanelOpen = useDesktopStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useDesktopStore((s) => s.toggleAgentPanel);
  const windows = useDesktopStore((s) => s.windows);
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

  // Right-click arrow drag state
  const [arrowDrag, setArrowDrag] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);
  const arrowDragActive = useRef(false);
  const arrowDragListeners = useRef<{
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
      if (arrowDragListeners.current) {
        document.removeEventListener('mousemove', arrowDragListeners.current.move);
        document.removeEventListener('mouseup', arrowDragListeners.current.up);
      }
    };
  }, []);

  const appsVersion = useDesktopStore((s) => s.appsVersion);
  const appBadges = useDesktopStore((s) => s.appBadges);
  const storeShortcuts = useDesktopStore((s) => s.shortcuts);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [shortcuts, setShortcuts] = useState<DesktopShortcut[]>([]);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(new Set());

  // Fetch available apps on mount and when appsVersion changes (after deploy)
  const fetchedVersionRef = useRef(-1);
  useEffect(() => {
    if (fetchedVersionRef.current === appsVersion) return;
    fetchedVersionRef.current = appsVersion;
    async function fetchApps() {
      try {
        const response = await apiFetch('/api/apps');
        if (response.ok) {
          const data = await response.json();
          setApps(data.apps || []);
          setOnboardingCompleted(!!data.onboardingCompleted);
          if (data.language && data.language !== useDesktopStore.getState().language) {
            useDesktopStore.getState().applyServerLanguage(data.language);
          }
        }
      } catch (err) {
        console.error('Failed to fetch apps:', err);
      }
    }
    fetchApps();
  }, [appsVersion]);

  // Fetch shortcuts on mount
  useEffect(() => {
    async function fetchShortcuts() {
      try {
        const response = await apiFetch('/api/shortcuts');
        if (response.ok) {
          const data = await response.json();
          setShortcuts(data.shortcuts || []);
        }
      } catch (err) {
        console.error('Failed to fetch shortcuts:', err);
      }
    }
    fetchShortcuts();
  }, []);

  // Merge fetched shortcuts with store shortcuts (store takes precedence for real-time updates)
  const mergedShortcuts = useMemo(() => {
    const map = new Map<string, DesktopShortcut>();
    for (const s of shortcuts) map.set(s.id, s);
    for (const s of storeShortcuts) map.set(s.id, s);
    return Array.from(map.values());
  }, [shortcuts, storeShortcuts]);

  // Global keyboard shortcuts: Shift+Tab for CLI mode, Ctrl+1..9 for monitors
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

  const agentList = Object.values(activeAgents);

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

  // Double-click prevention: track which icon is in cooldown
  const [cooldownId, setCooldownId] = useState<string | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const startCooldown = useCallback((id: string) => {
    setCooldownId(id);
    clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldownId(null), 1000);
  }, []);

  useEffect(() => () => clearTimeout(cooldownTimer.current), []);

  const handleAppClick = useCallback(
    (appId: string) => {
      if (cooldownId === appId) return;
      startCooldown(appId);
      sendMessage(`<user_interaction:click>app: ${appId}</user_interaction:click>`);
    },
    [sendMessage, cooldownId, startCooldown],
  );

  const handleShortcutClick = useCallback(
    (shortcut: DesktopShortcut) => {
      if (cooldownId === shortcut.id) return;
      startCooldown(shortcut.id);
      sendMessage(
        `<user_interaction:click>shortcut: ${shortcut.id}, type: ${shortcut.type}, target: ${shortcut.target}</user_interaction:click>`,
      );
    },
    [sendMessage, cooldownId, startCooldown],
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
              .queueGestureMessage(
                `<user_interaction:image_drop>\n${imageLines}\n</user_interaction:image_drop>`,
              );
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
              .queueGestureMessage(
                `<user_interaction:file_drop>\n${fileLines}\n</user_interaction:file_drop>`,
              );
          }
        });
      }
    }
  }, []);

  // Describe what's at a given screen point for arrow drag interactions
  const describePointTarget = useCallback((x: number, y: number): string => {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if ('arrowOverlay' in ((el as HTMLElement).dataset ?? {})) continue;
      const winEl = (el as HTMLElement).closest<HTMLElement>('[data-window-id]');
      if (winEl) {
        const wid = winEl.dataset.windowId!;
        const win = useDesktopStore.getState().windows[wid];
        const title = win?.title ?? wid;
        return `window "${title}" (id: ${getRawWindowId(wid)})`;
      }
      const appEl = (el as HTMLElement).closest<HTMLElement>('[data-app-id]');
      if (appEl) return `app "${appEl.dataset.appId}"`;
      const shortcutEl = (el as HTMLElement).closest<HTMLElement>('[data-shortcut-id]');
      if (shortcutEl) return `shortcut "${shortcutEl.dataset.shortcutId}"`;
    }
    return `desktop (${Math.round(x)}, ${Math.round(y)})`;
  }, []);

  // Right-click arrow drag handler (captures from anywhere including windows)
  const handleArrowDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 2) return;

      const startX = e.clientX;
      const startY = e.clientY;
      arrowDragActive.current = false;

      // Full-screen overlay to capture all mouse events during drag,
      // preventing iframes, buttons, and text from intercepting them.
      const overlay = document.createElement('div');
      overlay.dataset.arrowOverlay = '';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;';
      document.body.appendChild(overlay);

      const DRAG_THRESHOLD = 5;

      const handleMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (
          !arrowDragActive.current &&
          Math.abs(dx) < DRAG_THRESHOLD &&
          Math.abs(dy) < DRAG_THRESHOLD
        )
          return;
        arrowDragActive.current = true;
        setArrowDrag({ startX, startY, endX: ev.clientX, endY: ev.clientY });
      };

      const handleMouseUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        arrowDragListeners.current = null;
        overlay.remove();

        if (arrowDragActive.current) {
          const from = describePointTarget(startX, startY);
          const to = describePointTarget(ev.clientX, ev.clientY);
          useDesktopStore
            .getState()
            .queueGestureMessage(
              `<user_interaction:drag>\n  from: ${from}\n  to: ${to}\n</user_interaction:drag>`,
            );
          setArrowDrag(null);
          // Suppress the context menu that would fire after right-button mouseup
          document.addEventListener(
            'contextmenu',
            (cm) => {
              cm.preventDefault();
              cm.stopPropagation();
            },
            { capture: true, once: true },
          );
        }
        arrowDragActive.current = false;
      };

      if (arrowDragListeners.current) {
        document.removeEventListener('mousemove', arrowDragListeners.current.move);
        document.removeEventListener('mouseup', arrowDragListeners.current.up);
      }
      arrowDragListeners.current = { move: handleMouseMove, up: handleMouseUp };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [describePointTarget],
  );

  const handleDesktopMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Right-click: start arrow drag (handled separately, captures from anywhere)
      if (e.button === 2) return;
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
            const winEl = (el as HTMLElement).closest<HTMLElement>('[data-window-id]');
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
          const winEl = (el as HTMLElement).closest<HTMLElement>('[data-window-id]');
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
        onMouseDown={(e) => {
          handleArrowDragStart(e);
          handleDesktopMouseDown(e);
        }}
        onDragOver={handleDesktopDragOver}
        onDragLeave={handleDesktopDragLeave}
        onDrop={handleDesktopDrop}
      >
        {/* Connection status indicator */}
        <div className={styles.statusBar}>
          <span className={styles.statusDot} data-status={connectionStatus} />
          <span className={styles.statusText}>
            {connectionStatus === 'connected'
              ? `Connected (${providerType || 'agent'})`
              : connectionStatus === 'connecting'
                ? 'Connecting...'
                : 'Disconnected'}
          </span>
          {agentList.length > 0 && (
            <>
              <span className={styles.statusDivider} />
              <button
                className={styles.agentIndicatorButton}
                onClick={toggleAgentPanel}
                title="Click to expand agent panel"
              >
                {agentList.map((agent) => (
                  <div key={agent.id} className={styles.agentIndicator}>
                    <span className={styles.agentSpinner} />
                    <span className={styles.agentStatus}>{agent.status}</span>
                  </div>
                ))}
                <span className={styles.expandArrow} data-open={agentPanelOpen}>
                  {agentPanelOpen ? '▲' : '▼'}
                </span>
              </button>
            </>
          )}
        </div>

        {/* Expanded agent panel */}
        {agentPanelOpen && agentList.length > 0 && (
          <div className={styles.agentPanel}>
            <div className={styles.agentPanelHeader}>
              <span>Active Agents</span>
              <button className={styles.stopAllButton} onClick={interrupt} title="Stop all agents">
                Stop All
              </button>
            </div>
            <div className={styles.agentPanelList}>
              {agentList.map((agent) => {
                // Find window associated with this agent (keyed by agentId)
                const windowAgent = windowAgents[agent.id];
                const windowId = windowAgent?.windowId;
                const windowTitle = windowId ? windows[windowId]?.title : null;

                return (
                  <div key={agent.id} className={styles.agentPanelItem}>
                    <div className={styles.agentPanelInfo}>
                      <span className={styles.agentPanelId}>{agent.id}</span>
                      <span className={styles.agentPanelStatus}>{agent.status}</span>
                      {windowTitle && (
                        <span className={styles.agentPanelWindow}>Window: {windowTitle}</span>
                      )}
                    </div>
                    <button
                      className={styles.stopAgentButton}
                      onClick={() => interruptAgent(agent.id)}
                      title={`Stop agent ${agent.id}`}
                    >
                      Stop
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Desktop icons */}
        <div className={styles.desktopIcons}>
          {/* Onboarding icon (shown until onboarding is completed) */}
          {!onboardingCompleted && (
            <button
              className={styles.desktopIcon}
              onClick={() => handleAppClick('onboarding')}
              disabled={cooldownId === 'onboarding'}
            >
              <span className={styles.iconImage}>🚀</span>
              <span className={styles.iconLabel}>Start</span>
            </button>
          )}
          {/* Dynamic app icons (hidden apps filtered out) */}
          {apps
            .filter((a) => !a.hidden)
            .map((app) => (
              <button
                key={app.id}
                className={`${styles.desktopIcon}${selectedAppIds.has(app.id) ? ` ${styles.desktopIconSelected}` : ''}`}
                data-app-id={app.id}
                onClick={() => handleAppClick(app.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showContextMenu(e.clientX, e.clientY);
                }}
                disabled={cooldownId === app.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-yaar-app', app.id);
                  e.dataTransfer.effectAllowed = 'link';
                }}
              >
                <span className={styles.iconWrapper}>
                  {app.iconType === 'image' ? (
                    <img
                      className={styles.iconImg}
                      src={resolveAssetUrl(app.icon!)}
                      alt={app.name}
                      draggable={false}
                    />
                  ) : (
                    <span className={styles.iconImage}>{app.icon || '📦'}</span>
                  )}
                  {appBadges[app.id] > 0 && (
                    <span className={styles.badge}>
                      {appBadges[app.id] > 99 ? '99+' : appBadges[app.id]}
                    </span>
                  )}
                </span>
                <span className={styles.iconLabel}>{app.name}</span>
              </button>
            ))}
          {/* Desktop shortcuts */}
          {mergedShortcuts.map((shortcut) => (
            <button
              key={shortcut.id}
              className={`${styles.desktopIcon}${selectedAppIds.has(shortcut.id) ? ` ${styles.desktopIconSelected}` : ''}`}
              data-shortcut-id={shortcut.id}
              onClick={() => handleShortcutClick(shortcut)}
              disabled={cooldownId === shortcut.id}
            >
              <span className={styles.iconWrapper}>
                {shortcut.iconType === 'image' ? (
                  <img
                    className={styles.iconImg}
                    src={resolveAssetUrl(shortcut.icon)}
                    alt={shortcut.label}
                    draggable={false}
                  />
                ) : (
                  <span className={styles.iconImage}>{shortcut.icon || '🔗'}</span>
                )}
                <span className={styles.shortcutArrow}>↗</span>
              </span>
              <span className={styles.iconLabel}>{shortcut.label}</span>
            </button>
          ))}
        </div>

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

      {/* These must be outside .desktop to avoid transform breaking fixed positioning */}
      {arrowDrag && (
        <svg
          data-arrow-overlay
          style={{
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 99998,
          }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="10"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="rgba(255,255,255,0.85)" />
            </marker>
          </defs>
          <circle cx={arrowDrag.startX} cy={arrowDrag.startY} r={4} fill="rgba(255,255,255,0.85)" />
          <line
            x1={arrowDrag.startX}
            y1={arrowDrag.startY}
            x2={arrowDrag.endX}
            y2={arrowDrag.endY}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={2}
            markerEnd="url(#arrowhead)"
          />
        </svg>
      )}
      <DrawingOverlay />
      <CommandPalette />
      <ToastContainer onToastAction={sendToastAction} />
      <ConfirmDialog />
      <UserPrompt />
    </>
  );
}
