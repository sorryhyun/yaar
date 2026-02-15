/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import { useDesktopStore, handleAppProtocolRequest } from '@/store';
import type { ClientEvent, ServerEvent, AppProtocolRequest } from '@/types';
import {
  createWsManager,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY,
  sendEvent,
  shouldReconnect,
} from './use-agent-connection/transport-manager';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';
import { dispatchServerEvent } from './use-agent-connection/server-event-dispatcher';
import {
  generateActionId,
  generateMessageId,
} from './use-agent-connection/outbound-command-helpers';
import { getRawWindowId } from '@/store/helpers';

const wsManager = createWsManager();

function buildWsUrl(): string {
  const state = useDesktopStore.getState();
  return buildWsUrlFromApi(state.sessionId);
}

interface UseAgentConnectionOptions {
  autoConnect?: boolean;
}

export function useAgentConnection(options: UseAgentConnectionOptions = {}) {
  const { autoConnect = true } = options;

  const isConnected = useSyncExternalStore(
    (cb) => wsManager.subscribe(cb),
    () => wsManager.getSnapshot(),
    () => false,
  );
  const [isConnecting, setIsConnecting] = useState(false);

  const {
    applyActions,
    setConnectionStatus,
    setSession,
    addDebugEntry,
    setAgentActive,
    clearAgent,
    clearAllAgents,
    consumePendingFeedback,
    consumePendingInteractions,
    consumeGestureMessages,
    consumePendingAppProtocolResponses,
    consumeAppProtocolReady,
    consumePendingAppInteractions,
    consumeDrawing,
    consumeAttachedImages,
    registerWindowAgent,
    updateWindowAgentStatus,
    setRestorePrompt,
    updateCliStreaming,
    finalizeCliStreaming,
    addCliEntry,
  } = useDesktopStore();

  const checkForPreviousSession = useCallback(
    async (currentSessionId: string) => {
      const currentWindows = useDesktopStore.getState().windows;
      if (Object.keys(currentWindows).length > 0) return;

      try {
        const response = await apiFetch('/api/sessions');
        if (!response.ok) return;

        const data = await response.json();
        const sessions = data.sessions || [];
        const previousSessions = sessions.filter(
          (s: { sessionId: string }) => s.sessionId !== currentSessionId,
        );

        if (previousSessions.length > 0) {
          const lastSession = previousSessions[0];
          setRestorePrompt({
            sessionId: lastSession.sessionId,
            sessionDate: lastSession.metadata?.createdAt || new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('Failed to check for previous sessions:', err);
      }
    },
    [setRestorePrompt],
  );

  const handleAppProtocolRequestCb = useCallback(
    (requestId: string, windowId: string, request: AppProtocolRequest) => {
      handleAppProtocolRequest(requestId, windowId, request);
    },
    [],
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data) as ServerEvent;
        dispatchServerEvent(message, {
          applyActions,
          setIsConnecting,
          setConnectionStatus,
          setSession,
          checkForPreviousSession,
          addDebugEntry,
          setAgentActive,
          clearAgent,
          registerWindowAgent,
          updateWindowAgentStatus,
          updateCliStreaming,
          finalizeCliStreaming,
          addCliEntry,
          handleAppProtocolRequest: handleAppProtocolRequestCb,
        });
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    },
    [
      applyActions,
      setConnectionStatus,
      setSession,
      addDebugEntry,
      setAgentActive,
      clearAgent,
      registerWindowAgent,
      updateWindowAgentStatus,
      checkForPreviousSession,
      updateCliStreaming,
      finalizeCliStreaming,
      addCliEntry,
      handleAppProtocolRequestCb,
    ],
  );

  const connect = useCallback(() => {
    if (
      wsManager.ws?.readyState === WebSocket.OPEN ||
      wsManager.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    setIsConnecting(true);
    setConnectionStatus('connecting');

    wsManager.ws = new WebSocket(buildWsUrl());

    wsManager.ws.onopen = () => {
      wsManager.reconnectAttempts = 0;
      wsManager.notify();

      // Subscribe to the current monitor (default to 'monitor-0' if not yet set)
      const activeMonitorId = useDesktopStore.getState().activeMonitorId ?? 'monitor-0';
      if (wsManager.ws?.readyState === WebSocket.OPEN) {
        sendEvent(wsManager, { type: 'SUBSCRIBE_MONITOR', monitorId: activeMonitorId });
      }
    };

    wsManager.ws.onmessage = handleMessage;

    wsManager.ws.onclose = (event) => {
      setIsConnecting(false);
      setConnectionStatus('disconnected');
      wsManager.ws = null;
      wsManager.notify();

      if (shouldReconnect(event.code, wsManager.reconnectAttempts)) {
        wsManager.reconnectAttempts++;
        wsManager.reconnectTimeout = window.setTimeout(connect, RECONNECT_DELAY);
      }
    };

    wsManager.ws.onerror = () => {
      setConnectionStatus('error', 'Connection failed');
    };
  }, [handleMessage, setConnectionStatus]);

  const disconnect = useCallback(() => {
    if (wsManager.reconnectTimeout) {
      clearTimeout(wsManager.reconnectTimeout);
      wsManager.reconnectTimeout = null;
    }
    wsManager.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;

    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      wsManager.ws.close(1000, 'User disconnect');
      wsManager.ws = null;
      wsManager.notify();
    }

    setConnectionStatus('disconnected');
    clearAllAgents();
  }, [setConnectionStatus, clearAllAgents]);

  const send = useCallback(
    (event: ClientEvent) => {
      if (sendEvent(wsManager, event)) {
        addDebugEntry({
          direction: 'out',
          type: event.type,
          data: event,
        });
      } else {
        console.warn('WebSocket not connected, cannot send:', event);
      }
    },
    [addDebugEntry],
  );

  const sendMessage = useCallback(
    (content: string) => {
      const drawing = consumeDrawing();
      const images = consumeAttachedImages();
      const messageId = generateMessageId();
      const monitorId = useDesktopStore.getState().activeMonitorId;
      addCliEntry({ type: 'user', content, monitorId });

      const interactions: Array<{ type: 'draw'; timestamp: number; imageData: string }> = [];
      if (drawing) {
        interactions.push({ type: 'draw', timestamp: Date.now(), imageData: drawing });
      }
      for (const img of images) {
        interactions.push({ type: 'draw', timestamp: Date.now(), imageData: img });
      }

      send({
        type: 'USER_MESSAGE',
        messageId,
        content,
        monitorId,
        interactions: interactions.length > 0 ? interactions : undefined,
      });
    },
    [send, consumeDrawing, consumeAttachedImages, addCliEntry],
  );

  const sendWindowMessage = useCallback(
    (windowId: string, content: string) => {
      const messageId = generateMessageId();
      send({ type: 'WINDOW_MESSAGE', messageId, windowId: getRawWindowId(windowId), content });
    },
    [send],
  );

  const sendDialogFeedback = useCallback(
    (dialogId: string, confirmed: boolean, rememberChoice?: 'once' | 'always' | 'deny_always') => {
      send({ type: 'DIALOG_FEEDBACK', dialogId, confirmed, rememberChoice });
    },
    [send],
  );

  const sendToastAction = useCallback(
    (toastId: string, eventId: string) => {
      send({ type: 'TOAST_ACTION', toastId, eventId });
    },
    [send],
  );

  const sendComponentAction = useCallback(
    (
      windowId: string,
      windowTitle: string,
      action: string,
      parallel?: boolean,
      formData?: Record<string, string | number | boolean>,
      formId?: string,
      componentPath?: string[],
    ) => {
      const actionId = generateActionId(parallel);
      send({
        type: 'COMPONENT_ACTION',
        windowId: getRawWindowId(windowId),
        windowTitle,
        action,
        actionId,
        formData,
        formId,
        componentPath,
      });
    },
    [send],
  );

  const interrupt = useCallback(() => {
    send({ type: 'INTERRUPT' });
  }, [send]);

  const reset = useCallback(() => {
    send({ type: 'RESET' });
    useDesktopStore.getState().resetDesktop();
  }, [send]);

  const setProvider = useCallback(
    (provider: 'claude' | 'codex') => {
      send({ type: 'SET_PROVIDER', provider });
    },
    [send],
  );

  const interruptAgent = useCallback(
    (agentId: string) => {
      send({ type: 'INTERRUPT_AGENT', agentId });
    },
    [send],
  );

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingFeedback.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const feedback = consumePendingFeedback();
        for (const item of feedback) {
          send({
            type: 'RENDERING_FEEDBACK',
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
            type: 'APP_PROTOCOL_RESPONSE',
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
            type: 'APP_PROTOCOL_READY',
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
            type: 'WINDOW_MESSAGE',
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
          // Unscope windowIds before sending to server (store uses monitorId-scoped keys)
          const unscopedInteractions = interactions.map((i) =>
            i.windowId ? { ...i, windowId: getRawWindowId(i.windowId) } : i,
          );
          send({ type: 'USER_INTERACTION', interactions: unscopedInteractions });
        }
      }
    });
    return unsubscribe;
  }, [consumePendingInteractions, send]);

  // Drain gesture messages (drag, selection, region) and send as USER_MESSAGE
  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingGestureMessages.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const messages = consumeGestureMessages();
        for (const content of messages) {
          const messageId = generateMessageId();
          const monitorId = useDesktopStore.getState().activeMonitorId;
          addCliEntry({ type: 'user', content, monitorId });
          send({ type: 'USER_MESSAGE', messageId, content, monitorId });
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

  useEffect(() => {
    let previousMonitorId = useDesktopStore.getState().activeMonitorId;
    let previousMonitorIds = new Set(useDesktopStore.getState().monitors.map((m) => m.id));
    const unsubscribe = useDesktopStore.subscribe((state) => {
      // Detect monitor subscription change
      if (state.activeMonitorId !== previousMonitorId) {
        previousMonitorId = state.activeMonitorId;
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          sendEvent(wsManager, { type: 'SUBSCRIBE_MONITOR', monitorId: state.activeMonitorId });
        }
      }

      // Detect monitor removals and notify server
      const currentMonitorIds = new Set(state.monitors.map((m) => m.id));
      if (wsManager.ws?.readyState === WebSocket.OPEN) {
        for (const id of previousMonitorIds) {
          if (!currentMonitorIds.has(id)) {
            sendEvent(wsManager, { type: 'REMOVE_MONITOR', monitorId: id });
          }
        }
      }
      previousMonitorIds = currentMonitorIds;
    });
    return unsubscribe;
  }, []);

  return {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    sendMessage,
    sendWindowMessage,
    sendComponentAction,
    sendDialogFeedback,
    sendToastAction,
    interrupt,
    interruptAgent,
    setProvider,
    reset,
  };
}
