/**
 * WindowContextMenu - Right-click context menu for asking about windows.
 */
import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import styles from './WindowContextMenu.module.css'

interface WindowContextMenuProps {
  x: number
  y: number
  windowId: string
  windowTitle: string
  onSend: (message: string) => void
  onClose: () => void
}

export function WindowContextMenu({
  x,
  y,
  windowTitle,
  onSend,
  onClose,
}: WindowContextMenuProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Adjust position to stay within viewport
  const [adjustedPos, setAdjustedPos] = useState({ x, y })
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let newX = x
      let newY = y

      // Adjust if menu would go off-screen
      if (x + rect.width > viewportWidth) {
        newX = viewportWidth - rect.width - 8
      }
      if (y + rect.height > viewportHeight) {
        newY = viewportHeight - rect.height - 8
      }

      setAdjustedPos({ x: newX, y: newY })
    }
  }, [x, y])

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim()
    if (trimmed) {
      onSend(`[Re: "${windowTitle}"] ${trimmed}`)
      onClose()
    }
  }, [input, windowTitle, onSend, onClose])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  // Prevent click propagation to close menu
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      onClick={handleClick}
    >
      <div className={styles.header}>Ask about "{windowTitle}"</div>
      <div className={styles.inputRow}>
        <input
          ref={inputRef}
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your question..."
        />
        <button
          className={styles.sendButton}
          onClick={handleSubmit}
          disabled={!input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
