/**
 * TerminalPane - A single terminal pane for one monitor's CLI history.
 */
import { useEffect, useRef } from 'react';
import { useDesktopStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import styles from '@/styles/ui/CliPanel.module.css';

interface TerminalPaneProps {
  monitorId: string;
  index: number;
  isFocused: boolean;
  onClick: () => void;
}

export function TerminalPane({ monitorId, index, isFocused, onClick }: TerminalPaneProps) {
  const history = useDesktopStore(useShallow((s) => s.cliHistory[monitorId] ?? []));
  const streaming = useDesktopStore(useShallow((s) => s.cliStreaming));
  const clearCliHistory = useDesktopStore((s) => s.clearCliHistory);
  const monitorLabel = useDesktopStore(
    (s) => s.monitors.find((m) => m.id === monitorId)?.label ?? monitorId,
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    shouldAutoScroll.current = isNearBottom;
  };

  useEffect(() => {
    if (shouldAutoScroll.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [history.length, streaming]);

  const streamingEntries = Object.values(streaming).filter(
    (e) => (e.monitorId || 'monitor-0') === monitorId,
  );

  const entryClass = (type: string) => {
    switch (type) {
      case 'user':
        return styles.user;
      case 'thinking':
        return styles.thinking;
      case 'response':
        return styles.response;
      case 'tool':
        return styles.tool;
      case 'error':
        return styles.error;
      case 'action-summary':
        return styles.actionSummary;
      default:
        return styles.response;
    }
  };

  return (
    <div className={styles.pane} data-focused={isFocused} onClick={onClick}>
      <span className={styles.paneBadge}>{index}</span>
      <div className={styles.paneHeader}>
        <span className={styles.paneLabel}>{monitorLabel}</span>
        <button
          className={styles.cliClearButton}
          onClick={(e) => {
            e.stopPropagation();
            clearCliHistory(monitorId);
          }}
        >
          Clear
        </button>
      </div>
      <div className={styles.cliBody} ref={bodyRef} onScroll={handleScroll}>
        {history.map((entry) => (
          <div key={entry.id} className={`${styles.entry} ${entryClass(entry.type)}`}>
            {entry.type === 'user' && <span className={styles.userPrompt}>&gt; </span>}
            {entry.content}
          </div>
        ))}
        {streamingEntries.map((entry) => (
          <div key={entry.id} className={`${styles.entry} ${entryClass(entry.type)}`}>
            {entry.type === 'thinking' && <span className={styles.streamingLabel}>[thinking]</span>}
            {entry.content}
            <span className={styles.cursor} />
          </div>
        ))}
      </div>
    </div>
  );
}
