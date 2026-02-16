/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Contains all windows
 */
import { useCallback, useEffect, useState, useRef } from 'react';
import { useDesktopStore, selectPanelWindows } from '@/store';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import { WindowManager } from './WindowManager';
import { WindowFrame } from '../windows/WindowFrame';
import { useShallow } from 'zustand/react/shallow';
import { ToastContainer } from '../ui/ToastContainer';
import { NotificationCenter } from '../ui/NotificationCenter';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CommandPalette } from '../ui/CommandPalette';
import { WindowContextMenu } from '../ui/WindowContextMenu';
import { CursorSpinner } from '../ui/CursorSpinner';
import { DrawingOverlay } from '../drawing/DrawingOverlay';
import { CliPanel } from '../ui/CliPanel';
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

  const appsVersion = useDesktopStore((s) => s.appsVersion);
  const appBadges = useDesktopStore((s) => s.appBadges);
  const [apps, setApps] = useState<AppInfo[]>([]);
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

  const handleDesktopMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only start selection when clicking directly on the desktop background
      if (e.target !== e.currentTarget || e.button !== 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      selectionStart.current = { x: startX, y: startY };
      selectionActive.current = false;

      const DRAG_THRESHOLD = 5;

      const handleMouseMove = (e: MouseEvent) => {
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

        // Compute which visible windows intersect
        const store = useDesktopStore.getState();
        const ids: string[] = [];
        for (const wid of store.zOrder) {
          const win = store.windows[wid];
          if (!win || win.minimized) continue;
          const b = win.bounds;
          // AABB intersection test
          if (
            !(
              rect.x > b.x + b.w ||
              rect.x + rect.w < b.x ||
              rect.y > b.y + b.h ||
              rect.y + rect.h < b.y
            )
          ) {
            ids.push(wid);
          }
        }
        setSelectedWindows(ids);

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
          } as React.CSSProperties
        }
        onClick={handleBackgroundClick}
        onContextMenu={handleBackgroundContextMenu}
        onMouseDown={handleDesktopMouseDown}
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
      <DrawingOverlay />
      <CommandPalette />
      <ToastContainer onToastAction={sendToastAction} />
      <ConfirmDialog />
    </>
  );
}
