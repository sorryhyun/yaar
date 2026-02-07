/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Contains all windows
 */
import { useCallback, useEffect, useState } from 'react'
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
import { Taskbar } from '../ui/Taskbar'
import { DrawingOverlay } from '../drawing/DrawingOverlay'
import styles from '@/styles/DesktopSurface.module.css'

/** App info from /api/apps endpoint */
interface AppInfo {
  id: string
  name: string
  hasSkill: boolean
  hasCredentials: boolean
}

/** Map app IDs to emoji icons (fallback to default) */
const APP_ICONS: Record<string, string> = {
  moltbook: '📱',
  default: '📦',
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
  const { sendMessage, sendWindowMessage, sendComponentAction, sendToastAction, interruptAgent, interrupt } = useAgentConnection({ autoConnect: false })

  const [apps, setApps] = useState<AppInfo[]>([])

  // Fetch available apps on mount
  useEffect(() => {
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
  }, [])

  const agentList = Object.values(activeAgents)

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Only handle clicks directly on the desktop
    if (e.target === e.currentTarget) {
      useDesktopStore.setState({ focusedWindowId: null })
    }
    // Always close context menu on background click
    hideContextMenu()
  }, [hideContextMenu])

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

  return (
    <div className={styles.desktop} onClick={handleBackgroundClick} onContextMenu={handleBackgroundContextMenu}>
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
            <span className={styles.iconImage}>
              {APP_ICONS[app.id] || APP_ICONS.default}
            </span>
            <span className={styles.iconLabel}>{app.name}</span>
          </button>
        ))}
      </div>

      {/* Window container */}
      <QueueAwareComponentActionProvider sendComponentAction={sendComponentAction}>
        <WindowManager />
      </QueueAwareComponentActionProvider>

      {/* Taskbar for minimized windows */}
      <Taskbar />

      {/* Command input */}
      <CommandPalette />

      {/* Toast notifications (bottom-right) */}
      <ToastContainer onToastAction={sendToastAction} />

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

      {/* Confirmation dialogs */}
      <ConfirmDialog />
    </div>
  )
}
