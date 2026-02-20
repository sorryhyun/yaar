/**
 * WindowContextMenu - Right-click context menu for asking about windows.
 */
import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '@/styles/overlays/WindowContextMenu.module.css';

interface WindowContextMenuProps {
  x: number;
  y: number;
  windowId?: string;
  windowTitle?: string;
  hasWindowAgent?: boolean;
  onSend: (message: string) => void;
  onSendToWindow: (windowId: string, message: string) => void;
  onClose: () => void;
}

export function WindowContextMenu({
  x,
  y,
  windowId,
  windowTitle,
  hasWindowAgent,
  onSend,
  onSendToWindow,
  onClose,
}: WindowContextMenuProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Adjust position to stay within viewport
  const [adjustedPos, setAdjustedPos] = useState({ x, y });
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newX = x;
      let newY = y;

      // Adjust if menu would go off-screen
      if (x + rect.width > viewportWidth) {
        newX = viewportWidth - rect.width - 8;
      }
      if (y + rect.height > viewportHeight) {
        newY = viewportHeight - rect.height - 8;
      }

      setAdjustedPos({ x: newX, y: newY });
    }
  }, [x, y]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed) {
      if (windowId) {
        // Send to window-specific agent (fork or continue)
        onSendToWindow(windowId, trimmed);
      } else {
        // Send to default agent
        onSend(trimmed);
      }
      onClose();
    }
  }, [input, windowId, onSend, onSendToWindow, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Prevent click propagation to close menu
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Determine header text based on whether a window agent exists
  const headerText = windowId
    ? hasWindowAgent
      ? t('contextMenu.continueWith', { title: windowTitle })
      : t('contextMenu.in', { title: windowTitle })
    : t('contextMenu.quickMessage');

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      onClick={handleClick}
    >
      <div className={styles.header}>{headerText}</div>
      <div className={styles.inputRow}>
        <input
          ref={inputRef}
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            windowId
              ? hasWindowAgent
                ? t('contextMenu.placeholder.continue')
                : t('contextMenu.placeholder.newAgent')
              : t('contextMenu.placeholder.message')
          }
        />
        <button className={styles.sendButton} onClick={handleSubmit} disabled={!input.trim()}>
          {t('contextMenu.send')}
        </button>
      </div>
    </div>
  );
}
