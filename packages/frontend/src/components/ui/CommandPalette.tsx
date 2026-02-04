/**
 * CommandPalette - Input for sending messages to the agent.
 */
import { useState, useCallback, KeyboardEvent } from 'react'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import { useDesktopStore } from '@/store'
import { DebugPanel } from './DebugPanel'
import { RecentActionsPanel } from './RecentActionsPanel'
import { SessionsModal } from './SessionsModal'
import styles from '@/styles/CommandPalette.module.css'

export function CommandPalette() {
  const [input, setInput] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const { isConnected, sendMessage, interrupt, reset } = useAgentConnection()
  const debugPanelOpen = useDesktopStore((state) => state.debugPanelOpen)
  const toggleDebugPanel = useDesktopStore((state) => state.toggleDebugPanel)
  const recentActionsPanelOpen = useDesktopStore((state) => state.recentActionsPanelOpen)
  const toggleRecentActionsPanel = useDesktopStore((state) => state.toggleRecentActionsPanel)
  const sessionsModalOpen = useDesktopStore((state) => state.sessionsModalOpen)
  const toggleSessionsModal = useDesktopStore((state) => state.toggleSessionsModal)
  const activeAgents = useDesktopStore((state) => state.activeAgents)
  const applyAction = useDesktopStore((state) => state.applyAction)
  const hasDrawing = useDesktopStore((state) => state.hasDrawing)
  const clearDrawing = useDesktopStore((state) => state.clearDrawing)

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim()
    // Allow sending if there's text OR a drawing attached
    if ((!trimmed && !hasDrawing) || !isConnected) return

    sendMessage(trimmed)
    setInput('')
  }, [input, isConnected, sendMessage, hasDrawing])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      setIsExpanded(false)
      const agentCount = Object.keys(activeAgents).length
      if (agentCount > 0) {
        interrupt()
        applyAction({
          type: 'toast.show',
          id: `interrupt-${Date.now()}`,
          message: agentCount === 1 ? 'Agent stopped' : `${agentCount} agents stopped`,
          variant: 'info'
        })
      }
    }
  }, [handleSubmit, interrupt, activeAgents, applyAction])

  return (
    <>
      {debugPanelOpen && <DebugPanel />}
      {recentActionsPanelOpen && <RecentActionsPanel />}
      {sessionsModalOpen && <SessionsModal />}
      <div className={styles.container} data-expanded={isExpanded}>
        {hasDrawing && (
          <div className={styles.drawingIndicator}>
            <span className={styles.drawingIcon}>&#9998;</span>
            <span>Drawing attached</span>
            <button
              className={styles.clearDrawingButton}
              onClick={clearDrawing}
              title="Clear drawing"
            >
              &times;
            </button>
          </div>
        )}
        <div className={styles.inputWrapper}>
          <textarea
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsExpanded(true)}
            placeholder={
              !isConnected
                ? "Connecting..."
                : isExpanded
                  ? "Enter to send, Shift+Enter for new line, Esc to cancel"
                  : "Ask the agent anything..."
            }
            disabled={!isConnected}
            rows={isExpanded ? 3 : 1}
          />
          <button
            className={styles.sendButton}
            onClick={handleSubmit}
            disabled={!isConnected || (!input.trim() && !hasDrawing)}
          >
            Send
          </button>
        </div>
        <div className={styles.toolbar}>
          <button
            className={styles.toolbarButton}
            onClick={toggleSessionsModal}
            title="View sessions"
            data-active={sessionsModalOpen}
          >
            Sessions
          </button>
          <button
            className={styles.toolbarButton}
            onClick={toggleRecentActionsPanel}
            title="View recent AI actions"
            data-active={recentActionsPanelOpen}
          >
            Actions
          </button>
          <button
            className={styles.toolbarButton}
            onClick={() => {
              reset()
              applyAction({
                type: 'toast.show',
                id: `reset-${Date.now()}`,
                message: 'Desktop and context reset',
                variant: 'info'
              })
            }}
            title="Reset windows and context"
          >
            Reset
          </button>
          <button
            className={styles.toolbarButton}
            onClick={toggleDebugPanel}
            title="Toggle debug panel"
            data-active={debugPanelOpen}
          >
            {'{ }'} Debug
          </button>
        </div>
      </div>
    </>
  )
}
