import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import type { ClientEvent } from '@/types';
import { wsManager } from './transport-manager';
import { generateMessageId } from './outbound-command-helpers';
import { getRawWindowId } from '@/store/helpers';

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
  const {
    consumePendingFeedback,
    consumePendingAppProtocolResponses,
    consumeAppProtocolReady,
    consumePendingAppInteractions,
    consumePendingInteractions,
    consumeGestureMessages,
  } = useDesktopStore();

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingFeedback.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const feedback = consumePendingFeedback();
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
      }
    });
    return unsubscribe;
  }, [consumePendingFeedback, send]);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (
        state.pendingAppProtocolResponses.length > 0 &&
        wsManager.ws?.readyState === WebSocket.OPEN
      ) {
        const items = consumePendingAppProtocolResponses();
        for (const item of items) {
          send({
            type: ClientEventType.APP_PROTOCOL_RESPONSE,
            requestId: item.requestId,
            windowId: getRawWindowId(item.windowId),
            response: item.response,
          });
        }
      }
    });
    return unsubscribe;
  }, [consumePendingAppProtocolResponses, send]);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingAppProtocolReady.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const windowIds = consumeAppProtocolReady();
        for (const windowId of windowIds) {
          send({
            type: ClientEventType.APP_PROTOCOL_READY,
            windowId: getRawWindowId(windowId),
          });
        }
      }
    });
    return unsubscribe;
  }, [consumeAppProtocolReady, send]);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingAppInteractions.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const items = consumePendingAppInteractions();
        for (const item of items) {
          const messageId = generateMessageId();
          send({
            type: ClientEventType.WINDOW_MESSAGE,
            messageId,
            windowId: getRawWindowId(item.windowId),
            content: `<app_interaction>${item.content}</app_interaction>`,
          });
        }
      }
    });
    return unsubscribe;
  }, [consumePendingAppInteractions, send]);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingInteractions.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const interactions = consumePendingInteractions();
        if (interactions.length > 0) {
          const unscopedInteractions = interactions.map((i) =>
            i.windowId ? { ...i, windowId: getRawWindowId(i.windowId) } : i,
          );
          send({ type: ClientEventType.USER_INTERACTION, interactions: unscopedInteractions });
        }
      }
    });
    return unsubscribe;
  }, [consumePendingInteractions, send]);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingGestureMessages.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const messages = consumeGestureMessages();
        for (const content of messages) {
          const messageId = generateMessageId();
          const monitorId = useDesktopStore.getState().activeMonitorId;
          addCliEntry({ type: 'user', content, monitorId });
          send({ type: ClientEventType.USER_MESSAGE, messageId, content, monitorId });
        }
      }
    });
    return unsubscribe;
  }, [consumeGestureMessages, send, addCliEntry]);

  useEffect(() => {
    let previousWindows = useDesktopStore.getState().windows;
    const consumeQueuedActions = useDesktopStore.getState().consumeQueuedActions;

    const unsubscribe = useDesktopStore.subscribe((state) => {
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
