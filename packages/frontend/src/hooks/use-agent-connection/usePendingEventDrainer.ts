import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import type { ClientEvent } from '@/types';
import { wsManager } from './transport-manager';
import { generateMessageId } from './outbound-command-helpers';
import { getRawWindowId } from '@/store/helpers';

/**
 * Drain a pending queue: check length, consume, and process items.
 * Reduces the repetitive if-length-consume pattern across all drain blocks.
 */
function drainQueue<T>(queue: T[], consume: () => T[], process: (items: T[]) => void): void {
  if (queue.length > 0) {
    process(consume());
  }
}

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
  // Use getState() for consume functions — they're stable refs, no need to subscribe
  const {
    consumePendingFeedback,
    consumePendingAppProtocolResponses,
    consumeAppProtocolReady,
    consumePendingAppInteractions,
    consumePendingInteractions,
    consumeGestureMessages,
  } = useDesktopStore.getState();

  // Single subscription for all pending-queue drains
  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (wsManager.ws?.readyState !== WebSocket.OPEN) return;

      // Skip if no pending items in any queue
      if (
        state.pendingFeedback.length === 0 &&
        state.pendingAppProtocolResponses.length === 0 &&
        state.pendingAppProtocolReady.length === 0 &&
        state.pendingAppInteractions.length === 0 &&
        state.pendingInteractions.length === 0 &&
        state.pendingGestureMessages.length === 0
      )
        return;

      drainQueue(state.pendingFeedback, consumePendingFeedback, (feedback) => {
        for (const item of feedback) {
          send({
            type: ClientEventType.RENDERING_FEEDBACK,
            requestId: item.requestId,
            windowId: getRawWindowId(item.windowId),
            renderer: item.renderer,
            success: item.success,
            error: item.error,
            url: item.url,
            locked: item.locked,
            imageData: item.imageData,
          });
        }
      });

      drainQueue(state.pendingAppProtocolResponses, consumePendingAppProtocolResponses, (items) => {
        for (const item of items) {
          send({
            type: ClientEventType.APP_PROTOCOL_RESPONSE,
            requestId: item.requestId,
            windowId: getRawWindowId(item.windowId),
            response: item.response,
          });
        }
      });

      drainQueue(state.pendingAppProtocolReady, consumeAppProtocolReady, (windowIds) => {
        for (const windowId of windowIds) {
          send({
            type: ClientEventType.APP_PROTOCOL_READY,
            windowId: getRawWindowId(windowId),
          });
        }
      });

      drainQueue(state.pendingAppInteractions, consumePendingAppInteractions, (items) => {
        for (const item of items) {
          const messageId = generateMessageId();
          send({
            type: ClientEventType.WINDOW_MESSAGE,
            messageId,
            windowId: getRawWindowId(item.windowId),
            content: `<app_interaction>${item.content}</app_interaction>${item.instructions ? `\n\n${item.instructions}` : ''}`,
          });
        }
      });

      drainQueue(state.pendingInteractions, consumePendingInteractions, (interactions) => {
        const unscopedInteractions = interactions.map((i) =>
          i.windowId ? { ...i, windowId: getRawWindowId(i.windowId) } : i,
        );
        send({ type: ClientEventType.USER_INTERACTION, interactions: unscopedInteractions });
      });

      drainQueue(state.pendingGestureMessages, consumeGestureMessages, (messages) => {
        for (const content of messages) {
          const messageId = generateMessageId();
          const monitorId = useDesktopStore.getState().activeMonitorId;
          addCliEntry({ type: 'user', content, monitorId });
          send({ type: ClientEventType.USER_MESSAGE, messageId, content, monitorId });
        }
      });
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
