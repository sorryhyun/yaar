/**
 * RecentActionsPanel - Displays an audit trail of AI actions.
 *
 * Shows human-readable summaries of OS Actions with expandable details.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useDesktopStore } from '@/store';
import type { OSAction } from '@yaar/shared';
import styles from '@/styles/overlays/RecentActionsPanel.module.css';

/**
 * Generate a human-readable summary of an OS Action.
 */
function getActionSummary(action: OSAction, t: TFunction): { summary: string; category: string } {
  switch (action.type) {
    case 'window.create':
      return {
        summary: t('recentActions.action.window.create', { title: action.title }),
        category: 'window',
      };
    case 'window.close':
      return {
        summary: t('recentActions.action.window.close', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.focus':
      return {
        summary: t('recentActions.action.window.focus', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.minimize':
      return {
        summary: t('recentActions.action.window.minimize', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.maximize':
      return {
        summary: t('recentActions.action.window.maximize', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.restore':
      return {
        summary: t('recentActions.action.window.restore', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.move':
      return {
        summary: t('recentActions.action.window.move', {
          windowId: action.windowId,
          x: action.x,
          y: action.y,
        }),
        category: 'window',
      };
    case 'window.resize':
      return {
        summary: t('recentActions.action.window.resize', {
          windowId: action.windowId,
          w: action.w,
          h: action.h,
        }),
        category: 'window',
      };
    case 'window.setTitle':
      return {
        summary: t('recentActions.action.window.setTitle', {
          title: action.title,
          windowId: action.windowId,
        }),
        category: 'window',
      };
    case 'window.setContent':
      return {
        summary: t('recentActions.action.window.setContent', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.updateContent':
      return {
        summary: t('recentActions.action.window.updateContent', {
          windowId: action.windowId,
          op: action.operation.op,
        }),
        category: 'window',
      };
    case 'window.lock':
      return {
        summary: t('recentActions.action.window.lock', { windowId: action.windowId }),
        category: 'window',
      };
    case 'window.unlock':
      return {
        summary: t('recentActions.action.window.unlock', { windowId: action.windowId }),
        category: 'window',
      };
    case 'notification.show':
      return {
        summary: t('recentActions.action.notification.show', { title: action.title }),
        category: 'notification',
      };
    case 'notification.dismiss':
      return {
        summary: t('recentActions.action.notification.dismiss', { id: action.id }),
        category: 'notification',
      };
    case 'toast.show':
      return {
        summary: t('recentActions.action.toast.show', { message: truncate(action.message, 40) }),
        category: 'toast',
      };
    case 'toast.dismiss':
      return {
        summary: t('recentActions.action.toast.dismiss', { id: action.id }),
        category: 'toast',
      };
    case 'dialog.confirm':
      return {
        summary: t('recentActions.action.dialog.confirm', { title: truncate(action.title, 40) }),
        category: 'dialog',
      };
    default: {
      // Handle any unknown action types
      const unknownAction = action as { type: string };
      return { summary: unknownAction.type, category: 'unknown' };
    }
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

interface ActionEntry {
  id: string;
  action: OSAction;
  timestamp: number;
}

export function RecentActionsPanel() {
  const { t } = useTranslation();
  const activityLog = useDesktopStore((state) => state.activityLog);
  const toggleRecentActionsPanel = useDesktopStore((state) => state.toggleRecentActionsPanel);
  const clearActivityLog = useDesktopStore((state) => state.clearActivityLog);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState({ x: 720, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const listenersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
  } | null>(null);

  // Cleanup document listeners on unmount
  useEffect(() => {
    return () => {
      if (listenersRef.current) {
        document.removeEventListener('mousemove', listenersRef.current.move);
        document.removeEventListener('mouseup', listenersRef.current.up);
        listenersRef.current = null;
      }
    };
  }, []);

  // Convert activity log to entries with IDs
  const entries: ActionEntry[] = activityLog.map((action, index) => ({
    id: `action-${index}`,
    action,
    timestamp: Date.now() - (activityLog.length - index) * 100, // Approximate timestamps
  }));

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      setIsDragging(true);
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };

      const handleMouseMove = (e: MouseEvent) => {
        setPosition({
          x: e.clientX - dragOffset.current.x,
          y: e.clientY - dragOffset.current.y,
        });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        listenersRef.current = null;
      };

      listenersRef.current = { move: handleMouseMove, up: handleMouseUp };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [position],
  );

  const formatData = (data: unknown) => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div
      className={styles.window}
      style={{ left: position.x, top: position.y }}
      data-dragging={isDragging}
    >
      <div className={styles.titleBar} onMouseDown={handleMouseDown}>
        <span className={styles.title}>{t('recentActions.title', { count: entries.length })}</span>
        <div className={styles.controls}>
          <button
            className={styles.controlBtn}
            onClick={clearActivityLog}
            title={t('recentActions.clear')}
          >
            {t('recentActions.clear')}
          </button>
          <button
            className={styles.controlBtn}
            data-action="close"
            onClick={toggleRecentActionsPanel}
            title="Close"
          >
            x
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {entries.length === 0 ? (
          <div className={styles.empty}>{t('recentActions.empty')}</div>
        ) : (
          [...entries].reverse().map((entry) => {
            const isExpanded = expandedIds.has(entry.id);
            const { summary, category } = getActionSummary(entry.action, t);

            return (
              <div
                key={entry.id}
                className={styles.entry}
                data-category={category}
                data-expanded={isExpanded}
                onClick={() => toggleExpand(entry.id)}
              >
                <div className={styles.entryHeader}>
                  <span className={styles.type} data-category={category}>
                    {entry.action.type}
                  </span>
                  <span className={styles.summary}>{summary}</span>
                </div>
                {isExpanded && <pre className={styles.data}>{formatData(entry.action)}</pre>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
