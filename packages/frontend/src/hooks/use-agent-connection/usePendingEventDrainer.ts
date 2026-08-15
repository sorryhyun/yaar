import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import type { ClientEvent } from '@/types';
import { wsManager } from './transport-manager';
import { generateMessageId } from './outbound-command-helpers';

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
 * Send everything the store has been holding, now.
 *
 * Callable directly, not only from the store subscription below, because a reconnect is
 * exactly the moment this must run and it is not a store change: the queues filled while
 * the socket was down and have sat unchanged ever since, so nothing would have woken the
 * subscriber. The attach handler calls this before asking for a snapshot — see
 * `flushPending` in useAgentConnection.
 */
export function drainPendingQueues({
  send,
  addCliEntry,
}: Pick<Deps, 'send' | 'addCliEntry'>): void {
  if (wsManager.ws?.readyState !== WebSocket.OPEN) return;

  const state = useDesktopStore.getState();
  const {
    consumePendingFeedback,
    consumePendingAppProtocolResponses,
    consumePendingAppInteractions,
    consumePendingAppEvents,
    consumePendingInteractions,
    consumeGestureMessages,
  } = state;

  // Skip if no pending items in any queue
  if (
    state.pendingFeedback.length === 0 &&
    state.pendingAppProtocolResponses.length === 0 &&
    state.pendingAppInteractions.length === 0 &&
    state.pendingAppEvents.length === 0 &&
    state.pendingInteractions.length === 0 &&
    state.pendingGestureMessages.length === 0
  )
    return;

  drainQueue(state.pendingFeedback, consumePendingFeedback, (feedback) => {
    for (const item of feedback) {
      send({
        type: ClientEventType.RENDERING_FEEDBACK,
        requestId: item.requestId,
        windowId: item.windowId,
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
        windowId: item.windowId,
        response: item.response,
      });
    }
  });

  drainQueue(state.pendingAppInteractions, consumePendingAppInteractions, (items) => {
    for (const item of items) {
      const messageId = generateMessageId();
      const content = `<app_interaction>${item.content}</app_interaction>${item.instructions ? `\n\n${item.instructions}` : ''}`;
      if (item.toMonitor) {
        const monitorId = useDesktopStore.getState().activeMonitorId;
        send({ type: ClientEventType.USER_MESSAGE, messageId, content, monitorId });
      } else {
        send({
          type: ClientEventType.APP_INTERACTION,
          messageId,
          windowId: item.windowId,
          content,
        });
      }
    }
  });

  drainQueue(state.pendingAppEvents, consumePendingAppEvents, (items) => {
    for (const item of items) {
      send({
        type: ClientEventType.APP_EVENT,
        messageId: generateMessageId(),
        windowId: item.windowId,
        channel: item.channel,
        payload: item.payload,
        ...(item.wakeAgent ? { wakeAgent: true } : {}),
      });
    }
  });

  drainQueue(state.pendingInteractions, consumePendingInteractions, (interactions) => {
    send({ type: ClientEventType.USER_INTERACTION, interactions });
  });

  drainQueue(state.pendingGestureMessages, consumeGestureMessages, (messages) => {
    for (const content of messages) {
      const messageId = generateMessageId();
      const monitorId = useDesktopStore.getState().activeMonitorId;
      addCliEntry({ type: 'user', content, monitorId });
      send({ type: ClientEventType.USER_MESSAGE, messageId, content, monitorId });
    }
  });
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
