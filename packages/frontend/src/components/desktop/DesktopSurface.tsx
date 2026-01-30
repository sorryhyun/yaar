/**
 * DesktopSurface - The main desktop background and container.
 *
 * Handles:
 * - Click to deselect windows
 * - Background styling
 * - Contains all windows
 */
import { useCallback } from 'react'
import { useDesktopStore } from '@/store'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import { QueueAwareComponentActionProvider } from '@/contexts/ComponentActionContext'
import { WindowManager } from './WindowManager'
import { ToastContainer } from '../ui/ToastContainer'
import { NotificationCenter } from '../ui/NotificationCenter'
import { CommandPalette } from '../ui/CommandPalette'
import { WindowContextMenu } from '../ui/WindowContextMenu'
import { CursorSpinner } from '../ui/CursorSpinner'
import styles from '@/styles/DesktopSurface.module.css'

export function DesktopSurface() {
  const connectionStatus = useDesktopStore(s => s.connectionStatus)
  const providerType = useDesktopStore(s => s.providerType)
  const contextMenu = useDesktopStore(s => s.contextMenu)
  const hideContextMenu = useDesktopStore(s => s.hideContextMenu)
  const showContextMenu = useDesktopStore(s => s.showContextMenu)
  const windowAgents = useDesktopStore(s => s.windowAgents)
  const activeAgents = useDesktopStore(s => s.activeAgents)
  const { sendMessage, sendWindowMessage, sendComponentAction } = useAgentConnection({ autoConnect: false })

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
    sendMessage('user clicked storage')
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
            {agentList.map((agent) => (
              <div key={agent.id} className={styles.agentIndicator}>
                <span className={styles.agentSpinner} />
                <span className={styles.agentStatus}>{agent.status}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Desktop icons */}
      <div className={styles.desktopIcons}>
        <button className={styles.desktopIcon} onClick={handleStorageClick}>
          <span className={styles.iconImage}>🗄️</span>
          <span className={styles.iconLabel}>Storage</span>
        </button>
      </div>

      {/* Window container */}
      <QueueAwareComponentActionProvider sendComponentAction={sendComponentAction}>
        <WindowManager />
      </QueueAwareComponentActionProvider>

      {/* Command input */}
      <CommandPalette />

      {/* Toast notifications (bottom-right) */}
      <ToastContainer />

      {/* Notification center (top-right) */}
      <NotificationCenter />

      {/* Window context menu */}
      {contextMenu && (
        <WindowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          windowId={contextMenu.windowId}
          windowTitle={contextMenu.windowTitle}
          hasWindowAgent={contextMenu.windowId ? !!windowAgents[contextMenu.windowId] : false}
          onSend={sendMessage}
          onSendToWindow={sendWindowMessage}
          onClose={hideContextMenu}
        />
      )}

      {/* Cursor spinner when AI is thinking */}
      <CursorSpinner />
    </div>
  )
}
