/**
 * CliWindowStrip - Renders visible windows inline above the CommandPalette in CLI mode.
 * Windows are displayed in a horizontal row with fixed height, not as floating overlays.
 */
import { useDesktopStore, selectVisibleWindows } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { MemoizedContentRenderer } from '../window/ContentRenderer';
import { WindowCallbackProvider } from '@/contexts/WindowCallbackContext';
import { useComponentAction } from '@/contexts/ComponentActionContext';
import { RendererErrorBoundary } from '../window/RendererErrorBoundary';
import { useCallback, useMemo } from 'react';
import type { FormValue } from '@/contexts/FormContext';
import styles from '@/styles/overlays/CliWindowStrip.module.css';

export function CliWindowStrip() {
  const windows = useDesktopStore(useShallow(selectVisibleWindows));
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);
  const userFocusWindow = useDesktopStore((s) => s.userFocusWindow);
  const userCloseWindow = useDesktopStore((s) => s.userCloseWindow);
  const sendComponentAction = useComponentAction();

  const onRenderSuccess = useCallback((requestId: string, winId: string, renderer: string) => {
    useDesktopStore
      .getState()
      .addRenderingFeedback({ requestId, windowId: winId, renderer, success: true });
  }, []);
  const onRenderError = useCallback(
    (requestId: string, winId: string, renderer: string, error: string, url?: string) => {
      useDesktopStore
        .getState()
        .addRenderingFeedback({ requestId, windowId: winId, renderer, success: false, error, url });
    },
    [],
  );

  if (windows.length === 0) return null;

  return (
    <div className={styles.strip}>
      {windows.map((w) => (
        <CliWindowCard
          key={w.id}
          window={w}
          isFocused={w.id === focusedWindowId}
          onFocus={userFocusWindow}
          onClose={userCloseWindow}
          onRenderSuccess={onRenderSuccess}
          onRenderError={onRenderError}
          sendComponentAction={sendComponentAction}
        />
      ))}
    </div>
  );
}

interface CliWindowCardProps {
  window: {
    id: string;
    title: string;
    content: import('@/types').WindowContent;
    requestId?: string;
    iframeToken?: string;
  };
  isFocused: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onRenderSuccess: (requestId: string, windowId: string, renderer: string) => void;
  onRenderError: (
    requestId: string,
    windowId: string,
    renderer: string,
    error: string,
    url?: string,
  ) => void;
  sendComponentAction: ReturnType<typeof useComponentAction>;
}

function CliWindowCard({
  window: w,
  isFocused,
  onFocus,
  onClose,
  onRenderSuccess,
  onRenderError,
  sendComponentAction,
}: CliWindowCardProps) {
  const onComponentAction = useCallback(
    (
      action: string,
      parallel?: boolean,
      formData?: Record<string, FormValue>,
      formId?: string,
      componentPath?: string[],
    ) => {
      sendComponentAction?.(w.id, w.title, action, parallel, formData, formId, componentPath);
    },
    [sendComponentAction, w.id, w.title],
  );

  const windowCallbacks = useMemo(
    () => ({ onRenderSuccess, onRenderError, onComponentAction }),
    [onRenderSuccess, onRenderError, onComponentAction],
  );

  return (
    <div className={styles.windowCard} data-focused={isFocused} onClick={() => onFocus(w.id)}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{w.title}</span>
        <button
          className={styles.cardClose}
          onClick={(e) => {
            e.stopPropagation();
            onClose(w.id);
          }}
        >
          ×
        </button>
      </div>
      <div className={styles.cardContent}>
        <WindowCallbackProvider callbacks={windowCallbacks}>
          <RendererErrorBoundary>
            <MemoizedContentRenderer
              content={w.content}
              windowId={w.id}
              requestId={w.requestId}
              iframeToken={w.iframeToken}
            />
          </RendererErrorBoundary>
        </WindowCallbackProvider>
      </div>
    </div>
  );
}
