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
import { WindowManager } from './WindowManager'
import { ToastContainer } from '../ui/ToastContainer'
import { NotificationCenter } from '../ui/NotificationCenter'
import { CommandPalette } from '../ui/CommandPalette'
import styles from '@/styles/DesktopSurface.module.css'

export function DesktopSurface() {
  const connectionStatus = useDesktopStore(s => s.connectionStatus)
  const providerType = useDesktopStore(s => s.providerType)

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    // Only handle clicks directly on the desktop
    if (e.target === e.currentTarget) {
      useDesktopStore.setState({ focusedWindowId: null })
    }
  }, [])

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
    </div>
  )
}
