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
import { WindowManager } from './WindowManager'
import { ToastContainer } from '../ui/ToastContainer'
import { NotificationCenter } from '../ui/NotificationCenter'
import { CommandPalette } from '../ui/CommandPalette'
import { WindowContextMenu } from '../ui/WindowContextMenu'
import styles from '@/styles/DesktopSurface.module.css'

export function DesktopSurface() {
  const connectionStatus = useDesktopStore(s => s.connectionStatus)
  const providerType = useDesktopStore(s => s.providerType)
  const contextMenu = useDesktopStore(s => s.contextMenu)
  const hideContextMenu = useDesktopStore(s => s.hideContextMenu)
  const { sendMessage } = useAgentConnection({ autoConnect: false })

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Only handle clicks directly on the desktop
    if (e.target === e.currentTarget) {
      useDesktopStore.setState({ focusedWindowId: null })
    }
    // Always close context menu on background click
    hideContextMenu()
  }, [hideContextMenu])

  return (
    <div className={styles.desktop} onClick={handleBackgroundClick}>
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
      </div>

      {/* Window container */}
      <WindowManager />

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
          onSend={sendMessage}
          onClose={hideContextMenu}
        />
      )}
    </div>
  )
}
