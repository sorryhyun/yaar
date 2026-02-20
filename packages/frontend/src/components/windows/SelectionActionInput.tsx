/**
 * Floating input that appears on right-click with selected text or after region select.
 * User types an instruction for the AI to execute on the selection.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useDesktopStore } from '@/store';
import { getRawWindowId } from '@/store/helpers';
import styles from '@/styles/windows/WindowFrame.module.css';

interface SelectionActionInputProps {
  x: number;
  y: number;
  selectedText: string;
  windowId: string;
  windowTitle: string;
  isRegion: boolean;
  onClose: () => void;
}

export function SelectionActionInput({
  x,
  y,
  selectedText,
  windowId,
  windowTitle,
  isRegion,
  onClose,
}: SelectionActionInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleClickOutside = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the right-click event
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleSubmit = useCallback(
    (instruction: string) => {
      if (!instruction.trim()) return;
      const rawId = getRawWindowId(windowId);
      const tag = isRegion && !selectedText ? 'region_select' : 'selection';
      const textPart = selectedText ? `\n  selected_text: "${selectedText.slice(0, 1000)}"` : '';
      useDesktopStore
        .getState()
        .queueGestureMessage(
          `<ui:${tag}>\n  instruction: "${instruction}"${textPart}\n  source: window "${windowTitle}" (id: ${rawId})\n</ui:${tag}>`,
        );
      onClose();
    },
    [windowId, windowTitle, selectedText, isRegion, onClose],
  );

  // Position the input near the cursor but keep it within viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, globalThis.innerWidth - 320),
    top: Math.min(y + 4, globalThis.innerHeight - 40),
    zIndex: 99999,
  };

  return (
    <div className={styles.selectionActionInput} style={style}>
      <input
        ref={inputRef}
        type="text"
        className={styles.selectionInput}
        placeholder={
          selectedText ? 'What to do with selection...' : 'What to do with this region...'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleSubmit((e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            onClose();
          }
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
