/**
 * CommandPalette - Input for sending messages to the agent.
 */
import { useState, useCallback, KeyboardEvent } from 'react'
import { useAgentConnection } from '@/hooks/useAgentConnection'
import { useDesktopStore } from '@/store'
import { DebugPanel } from './DebugPanel'
import styles from '@/styles/CommandPalette.module.css'

export function CommandPalette() {
  const [input, setInput] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const { isConnected, sendMessage, interrupt } = useAgentConnection()
  const debugPanelOpen = useDesktopStore((state) => state.debugPanelOpen)
  const toggleDebugPanel = useDesktopStore((state) => state.toggleDebugPanel)

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
      <div className={styles.container} data-expanded={isExpanded}>
        <div className={styles.inputWrapper}>
          <button
            className={styles.debugButton}
            onClick={toggleDebugPanel}
            title="Toggle debug panel"
            data-active={debugPanelOpen}
          >
            {'{ }'}
          </button>
          <textarea
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsExpanded(true)}
            placeholder={isConnected ? "Ask the agent anything..." : "Connecting..."}
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
        <div className={styles.hint}>
          Press Enter to send, Shift+Enter for new line, Esc to cancel
        </div>
      </div>
    </>
  )
}
