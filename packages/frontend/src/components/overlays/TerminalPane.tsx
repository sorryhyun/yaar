/**
 * TerminalPane - A single terminal pane for one monitor's CLI history.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useDesktopStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { CliEntry } from '@/types/state';
import styles from '@/styles/overlays/CliPanel.module.css';

interface TerminalPaneProps {
  monitorId: string;
  index: number;
  isFocused: boolean;
  onClick: () => void;
}

const MAX_CONTENT_LEN = 200;

/**
 * Scroll position per monitor, kept outside React so it survives the unmount
 * that happens whenever the CLI panel is toggled off (DesktopSurface renders
 * `cliMode && <CliPanel />`).
 */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();

/** Split "[label] rest" into a dimmed bracket + truncated content */
function renderContent(content: string) {
  const match = content.match(/^(\[[^\]]*\])\s?(.*)/s);
  if (!match) return content;
  const rest = match[2] || '';
  const truncated = rest.length > MAX_CONTENT_LEN ? rest.slice(0, MAX_CONTENT_LEN) + '…' : rest;
  return (
    <>
      <span className={styles.bracketLabel}>{match[1]}</span>
      {truncated ? ' ' + truncated : ''}
    </>
  );
}

function entryClass(type: string) {
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
    case 'notice':
      return styles.notice;
    case 'action-summary':
      return styles.actionSummary;
    default:
      return styles.response;
  }
}

/**
 * The committed history, rendered apart from the live tail.
 *
 * History only changes when a stream finalizes; the tail changes on every chunk. Left
 * in one component, a token re-rendered every committed line as well — up to
 * `MAX_CLI_ENTRIES` of them, per pane, per token, with every monitor's pane on screen
 * at once. Memoized on the array identity Immer already gives us: unchanged history
 * is the same array, so the rows are skipped entirely.
 */
const CliHistoryList = memo(function CliHistoryList({ history }: { history: CliEntry[] }) {
  return (
    <>
      {history.map((entry) => (
        <div key={entry.id} className={`${styles.entry} ${entryClass(entry.type)}`}>
          {entry.type === 'user' && <span className={styles.userPrompt}>&gt; </span>}
          {renderContent(entry.content)}
        </div>
      ))}
    </>
  );
});

export function TerminalPane({ monitorId, index, isFocused, onClick }: TerminalPaneProps) {
  const history = useDesktopStore(useShallow((s) => s.cliHistory[monitorId] ?? []));
  // Select this pane's entries inside the selector, not after it. Subscribed to the whole
  // `cliStreaming` map, every pane re-rendered on every chunk of every *other* monitor —
  // the cost of the CLI panel scaled with panes × streaming monitors. Narrowed here, the
  // shallow compare sees an element-identical array and the pane stands still.
  const streamingEntries = useDesktopStore(
    useShallow((s) =>
      Object.values(s.cliStreaming).filter((e) => (e.monitorId || '0') === monitorId),
    ),
  );
  const clearCliHistory = useDesktopStore((s) => s.clearCliHistory);
  const monitorLabel = useDesktopStore(
    (s) => s.monitors.find((m) => m.id === monitorId)?.label ?? monitorId,
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(scrollMemory.get(monitorId)?.atBottom ?? true);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    shouldAutoScroll.current = isNearBottom;
    scrollMemory.set(monitorId, { top: el.scrollTop, atBottom: isNearBottom });
  };

  // Restore the position the user was last looking at (before the auto-scroll
  // effect below runs), and persist it again on unmount.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const remembered = scrollMemory.get(monitorId);
    shouldAutoScroll.current = remembered?.atBottom ?? true;

    // `.cliBody` sets scroll-behavior: smooth, so a plain scrollTop assignment
    // animates from 0 — and any content settling mid-animation aborts it near
    // the top. Restoring must be instant.
    const jump = () => {
      if (remembered && !remembered.atBottom) {
        el.scrollTo({ top: remembered.top, behavior: 'instant' });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      }
    };
    jump();
    // Re-assert once layout has settled, in case the pane wasn't fully sized
    // on this first pass (a clamped assignment silently lands at 0).
    const raf = requestAnimationFrame(jump);

    return () => {
      cancelAnimationFrame(raf);
      if (!el.clientHeight) return; // detached or unlaid-out: values are junk
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      scrollMemory.set(monitorId, { top: el.scrollTop, atBottom });
    };
  }, [monitorId]);

  useEffect(() => {
    if (shouldAutoScroll.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [history.length, streamingEntries]);

  return (
    <div className={styles.pane} data-focused={isFocused} onClick={onClick}>
      <span className={styles.paneBadge}>{index}</span>
      <div className={styles.paneHeader}>
        <span className={styles.paneLabel}>{monitorLabel}</span>
        <div className={styles.paneHeaderActions}>
          <button
            className={styles.cliClearButton}
            onClick={(e) => {
              e.stopPropagation();
              const text = history.map((entry) => entry.content).join('\n');
              navigator.clipboard.writeText(text);
            }}
          >
            Copy
          </button>
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
      </div>
      <div className={styles.cliBody} ref={bodyRef} onScroll={handleScroll}>
        <CliHistoryList history={history} />
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
