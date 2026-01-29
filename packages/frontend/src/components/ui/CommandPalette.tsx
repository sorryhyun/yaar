/**
 * CommandPalette - Input for sending messages to the agent.
 */
import { useState, useCallback, KeyboardEvent } from 'react'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import { useDesktopStore } from '@/store'
import { DebugPanel } from './DebugPanel'
import { SessionsModal } from './SessionsModal'
import styles from '@/styles/CommandPalette.module.css'

export function CommandPalette() {
  const [input, setInput] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const { isConnected, sendMessage, interrupt } = useAgentConnection()
  const debugPanelOpen = useDesktopStore((state) => state.debugPanelOpen)
  const toggleDebugPanel = useDesktopStore((state) => state.toggleDebugPanel)
  const sessionsModalOpen = useDesktopStore((state) => state.sessionsModalOpen)
  const toggleSessionsModal = useDesktopStore((state) => state.toggleSessionsModal)
  const activeAgents = useDesktopStore((state) => state.activeAgents)

  const agentList = Object.values(activeAgents)

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || !isConnected) return

    sendMessage(trimmed)
    setInput('')
  }, [input, isConnected, sendMessage])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      setIsExpanded(false)
      interrupt()
    }
  }, [handleSubmit, interrupt])

  return (
    <>
      {debugPanelOpen && <DebugPanel />}
      {sessionsModalOpen && <SessionsModal />}
      <div className={styles.container} data-expanded={isExpanded}>
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
            disabled={!isConnected || !input.trim()}
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
            onClick={toggleDebugPanel}
            title="Toggle debug panel"
            data-active={debugPanelOpen}
          >
            {'{ }'} Debug
          </button>
          {agentList.length > 0 && (
            <div className={styles.spinnerBox}>
              {agentList.map((agent) => (
                <div key={agent.id} className={styles.spinnerItem} title={agent.status}>
                  <span className={styles.spinner} />
                  <span className={styles.spinnerLabel}>{agent.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
