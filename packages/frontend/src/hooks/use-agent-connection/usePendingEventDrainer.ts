import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import type { ClientEvent } from '@/types';
import { drainPendingQueues } from '@/lib/transport/pending-queues';

interface Deps {
  send: (event: ClientEvent) => void;
  sendComponentAction: (
    windowId: string,
    windowTitle: string,
    action: string,
    parallel?: boolean,
    formData?: Record<string, string | number | boolean>,
    formId?: string,
    componentPath?: string[],
  ) => void;
  addCliEntry: ReturnType<typeof useDesktopStore.getState>['addCliEntry'];
}

/**
 * Drains all pending event queues from the store and sends them over the WebSocket.
 * Extracted from useAgentConnection to keep that hook focused on connection lifecycle.
 */
export function usePendingEventDrainer({ send, sendComponentAction, addCliEntry }: Deps) {
  // Single subscription for all pending-queue drains
  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe(() => {
      drainPendingQueues({ send, addCliEntry });
    });
    return unsubscribe;
  }, [send, addCliEntry]);

  // Separate subscription for window-unlock → queued action replay
  useEffect(() => {
    let previousWindows = useDesktopStore.getState().windows;
    const consumeQueuedActions = useDesktopStore.getState().consumeQueuedActions;

    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.windows === previousWindows) return;
      for (const [windowId, window] of Object.entries(state.windows)) {
        const previousWindow = previousWindows[windowId];
        if (previousWindow?.locked && !window.locked) {
          const queuedActions = consumeQueuedActions(windowId);
          for (const action of queuedActions) {
            sendComponentAction(
              action.windowId,
              action.windowTitle,
              action.action,
              action.parallel,
              action.formData,
              action.formId,
              action.componentPath,
            );
          }
        }
      }
      previousWindows = state.windows;
    });

    return unsubscribe;
  }, [sendComponentAction]);
}
