/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Contains all windows
 */
import { useCallback, useEffect, useState, useRef } from 'react'
import { useDesktopStore } from '@/store'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext'
import { WindowManager } from './WindowManager'
import { ToastContainer } from '../ui/ToastContainer'
import { NotificationCenter } from '../ui/NotificationCenter'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { CommandPalette } from '../ui/CommandPalette'
import { WindowContextMenu } from '../ui/WindowContextMenu'
import { CursorSpinner } from '../ui/CursorSpinner'
import { DrawingOverlay } from '../drawing/DrawingOverlay'
import { CliPanel } from '../ui/CliPanel'
import styles from '@/styles/desktop/DesktopSurface.module.css'

/** App info from /api/apps endpoint */
interface AppInfo {
  id: string
  name: string
  icon?: string
  iconType?: 'emoji' | 'image'
  hasSkill: boolean
  hasCredentials: boolean
}

export function DesktopSurface() {
  const connectionStatus = useDesktopStore(s => s.connectionStatus)
  const providerType = useDesktopStore(s => s.providerType)
  const contextMenu = useDesktopStore(s => s.contextMenu)
  const hideContextMenu = useDesktopStore(s => s.hideContextMenu)
  const showContextMenu = useDesktopStore(s => s.showContextMenu)
  const windowAgents = useDesktopStore(s => s.windowAgents)
  const activeAgents = useDesktopStore(s => s.activeAgents)
  const agentPanelOpen = useDesktopStore(s => s.agentPanelOpen)
  const toggleAgentPanel = useDesktopStore(s => s.toggleAgentPanel)
  const windows = useDesktopStore(s => s.windows)
  const setSelectedWindows = useDesktopStore(s => s.setSelectedWindows)
  const cliMode = useDesktopStore(s => s.cliMode)
  const switchMonitor = useDesktopStore(s => s.switchMonitor)
  const { sendMessage, sendWindowMessage, sendComponentAction, sendToastAction, interruptAgent, interrupt } = useAgentConnection({ autoConnect: false })

  // Rubber-band selection state
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const selectionStart = useRef<{ x: number; y: number } | null>(null)
  const selectionActive = useRef(false)
  const selectionListeners = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null)

  // Clean up selection listeners on unmount
  useEffect(() => {
    return () => {
      if (selectionListeners.current) {
        document.removeEventListener('mousemove', selectionListeners.current.move)
        document.removeEventListener('mouseup', selectionListeners.current.up)
      }
    }
  }, [])

  const appsVersion = useDesktopStore(s => s.appsVersion)
  const [apps, setApps] = useState<AppInfo[]>([])

  // Fetch available apps on mount and when appsVersion changes (after deploy)
  const fetchedVersionRef = useRef(-1)
  useEffect(() => {
    if (fetchedVersionRef.current === appsVersion) return
    fetchedVersionRef.current = appsVersion
    async function fetchApps() {
      try {
        const response = await fetch('/api/apps')
        if (response.ok) {
          const data = await response.json()
          setApps(data.apps || [])
        }
      } catch (err) {
        console.error('Failed to fetch apps:', err)
      }
    }
    fetchApps()
  }, [appsVersion])

  // Global keyboard shortcuts: Shift+Tab for CLI mode, Ctrl+1..9 for monitors
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        useDesktopStore.getState().toggleCliMode()
        return
      }
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        const mons = useDesktopStore.getState().monitors
        if (idx < mons.length) {
          e.preventDefault()
          switchMonitor(mons[idx].id)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [switchMonitor])

  const agentList = Object.values(activeAgents)

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Only handle clicks directly on the desktop
    if (e.target === e.currentTarget) {
      useDesktopStore.setState({ focusedWindowId: null })
      setSelectedWindows([])
    }
    // Always close context menu on background click
    hideContextMenu()
  }, [hideContextMenu, setSelectedWindows])

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    // Only handle right-clicks directly on the desktop background
    if (e.target === e.currentTarget) {
      e.preventDefault()
      showContextMenu(e.clientX, e.clientY)
    }
  }, [showContextMenu])

  const handleStorageClick = useCallback(() => {
    sendMessage('<user_interaction:click>storage</user_interaction:click>')
  }, [sendMessage])

  const handleAppClick = useCallback((appId: string) => {
    sendMessage(`<user_interaction:click>app: ${appId}</user_interaction:click>`)
  }, [sendMessage])

  const handleDesktopMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start selection when clicking directly on the desktop background
    if (e.target !== e.currentTarget || e.button !== 0) return

    const startX = e.clientX
    const startY = e.clientY
    selectionStart.current = { x: startX, y: startY }
    selectionActive.current = false

    const DRAG_THRESHOLD = 5

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY

      // Don't show rect until past threshold
      if (!selectionActive.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      selectionActive.current = true

      const rect = {
        x: Math.min(startX, e.clientX),
        y: Math.min(startY, e.clientY),
        w: Math.abs(dx),
        h: Math.abs(dy),
      }
      setSelectionRect(rect)

      // Compute which visible windows intersect
      const store = useDesktopStore.getState()
      const ids: string[] = []
      for (const wid of store.zOrder) {
        const win = store.windows[wid]
        if (!win || win.minimized) continue
        const b = win.bounds
        // AABB intersection test
        if (!(rect.x > b.x + b.w || rect.x + rect.w < b.x || rect.y > b.y + b.h || rect.y + rect.h < b.y)) {
          ids.push(wid)
        }
      }
      setSelectedWindows(ids)
    }

    const handleMouseUp = () => {
      selectionStart.current = null
      setSelectionRect(null)
      selectionActive.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      selectionListeners.current = null
    }

    // Clean up any previous listeners (defensive)
    if (selectionListeners.current) {
      document.removeEventListener('mousemove', selectionListeners.current.move)
      document.removeEventListener('mouseup', selectionListeners.current.up)
    }
    selectionListeners.current = { move: handleMouseMove, up: handleMouseUp }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [setSelectedWindows])

  return (
    <>
      {/* CLI panel (behind desktop, slides in from left) */}
      {cliMode && <CliPanel />}

      <div className={styles.desktop} data-cli-mode={cliMode} onClick={handleBackgroundClick} onContextMenu={handleBackgroundContextMenu} onMouseDown={handleDesktopMouseDown}>
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
              <button
                className={styles.stopAllButton}
                onClick={interrupt}
                title="Stop all agents"
              >
                Stop All
              </button>
            </div>
            <div className={styles.agentPanelList}>
              {agentList.map((agent) => {
                // Find window associated with this agent (keyed by agentId)
                const windowAgent = windowAgents[agent.id]
                const windowId = windowAgent?.windowId
                const windowTitle = windowId ? windows[windowId]?.title : null

                return (
                  <div key={agent.id} className={styles.agentPanelItem}>
                    <div className={styles.agentPanelInfo}>
                      <span className={styles.agentPanelId}>{agent.id}</span>
                      <span className={styles.agentPanelStatus}>{agent.status}</span>
                      {windowTitle && (
                        <span className={styles.agentPanelWindow}>
                          Window: {windowTitle}
                        </span>
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
                )
              })}
            </div>
          </div>
        )}

        {/* Desktop icons */}
        <div className={styles.desktopIcons}>
          <button className={styles.desktopIcon} onClick={handleStorageClick}>
            <span className={styles.iconImage}>🗄️</span>
            <span className={styles.iconLabel}>Storage</span>
          </button>
          {/* Dynamic app icons */}
          {apps.map((app) => (
            <button
              key={app.id}
              className={styles.desktopIcon}
              onClick={() => handleAppClick(app.id)}
            >
              {app.iconType === 'image' ? (
                <img className={styles.iconImg} src={app.icon} alt={app.name} draggable={false} />
              ) : (
                <span className={styles.iconImage}>
                  {app.icon || '📦'}
                </span>
              )}
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
            hasWindowAgent={contextMenu.windowId ? Object.values(windowAgents).some(wa => wa.windowId === contextMenu.windowId) : false}
            onSend={sendMessage}
            onSendToWindow={sendWindowMessage}
            onClose={hideContextMenu}
          />
        )}

        {/* Drawing overlay */}
        <DrawingOverlay />

        {/* Cursor spinner when AI is thinking */}
        <CursorSpinner />
      </div>

      {/* These must be outside .desktop to avoid transform breaking fixed positioning */}
      <CommandPalette />
      <ToastContainer onToastAction={sendToastAction} />
      <ConfirmDialog />
    </>
  )
}
