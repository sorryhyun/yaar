/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import { useDesktopStore, handleAppProtocolRequest, handleVerbSubscriptionUpdate } from '@/store';
import type { ClientEvent, AppProtocolRequest } from '@/types';
import { ClientEventType } from '@/types';
import {
  wsManager,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY,
  sendEvent,
  shouldReconnect,
  dispatchServerEvent,
  generateActionId,
  generateMessageId,
  usePendingEventDrainer,
  useMonitorSync,
} from './use-agent-connection';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';
import { getRawWindowId } from '@/store/helpers';
import { captureMonitorScreenshot } from '@/lib/captureMonitorScreenshot';

let sessionCheckDone = false;

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
    consumeDrawing,
    consumeAttachedImages,
    registerWindowAgent,
    updateWindowAgentStatus,
    setRestorePrompt,
    updateCliStreaming,
    finalizeCliStreaming,
    addCliEntry,
    restoreCliHistory,
    incrementSubagentCount,
    decrementSubagentCount,
    trackMessage,
    acceptMessage,
    queueMessage,
    clearAllMessageStatuses,
  } = useDesktopStore.getState();

  const checkForPreviousSession = useCallback(async (currentSessionId: string) => {
    if (sessionCheckDone) return;
    sessionCheckDone = true;
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
  }, []);

  const handleAppProtocolRequestCb = useCallback(
    (requestId: string, windowId: string, request: AppProtocolRequest) => {
      handleAppProtocolRequest(requestId, windowId, request);
    },
    [],
  );

  const handleVerbSubscriptionUpdateCb = useCallback(
    (windowId: string, subscriptionId: string, uri: string) => {
      handleVerbSubscriptionUpdate(windowId, subscriptionId, uri);
    },
    [],
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
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
          handleVerbSubscriptionUpdate: handleVerbSubscriptionUpdateCb,
          restoreCliHistory,
          acceptMessage,
          queueMessage,
          clearAllMessageStatuses,
          incrementSubagentCount,
          decrementSubagentCount,
        });
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    },
    [checkForPreviousSession, handleAppProtocolRequestCb, handleVerbSubscriptionUpdateCb],
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

      const activeMonitorId = useDesktopStore.getState().activeMonitorId ?? '0';
      if (wsManager.ws?.readyState === WebSocket.OPEN) {
        sendEvent(wsManager, {
          type: ClientEventType.SUBSCRIBE_MONITOR,
          monitorId: activeMonitorId,
        });
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
  }, []);

  const send = useCallback((event: ClientEvent) => {
    if (sendEvent(wsManager, event)) {
      addDebugEntry({
        direction: 'out',
        type: event.type,
        data: event,
      });
    } else {
      console.warn('WebSocket not connected, cannot send:', event);
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      // Capture full monitor screenshot (with drawing strokes composited)
      // before consuming the drawing, so the sent image includes the desktop.
      const hasDrawingNow = useDesktopStore.getState().hasDrawing;
      let screenshotDataUrl: string | null = null;
      if (hasDrawingNow) {
        screenshotDataUrl = await captureMonitorScreenshot();
      }

      const drawing = consumeDrawing();
      const images = consumeAttachedImages();
      const messageId = generateMessageId();
      const monitorId = useDesktopStore.getState().activeMonitorId;
      trackMessage(messageId);
      addCliEntry({ type: 'user', content, monitorId });

      const interactions: Array<{ type: 'draw'; timestamp: number; imageData: string }> = [];
      // Prefer the composite screenshot; fall back to raw strokes
      const drawingImage = screenshotDataUrl ?? drawing;
      if (drawingImage) {
        interactions.push({ type: 'draw', timestamp: Date.now(), imageData: drawingImage });
      }
      for (const img of images) {
        interactions.push({ type: 'draw', timestamp: Date.now(), imageData: img });
      }

      send({
        type: ClientEventType.USER_MESSAGE,
        messageId,
        content,
        monitorId,
        interactions: interactions.length > 0 ? interactions : undefined,
      });
    },
    [send],
  );

  const sendWindowMessage = useCallback(
    (windowId: string, content: string) => {
      const messageId = generateMessageId();
      trackMessage(messageId);
      send({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId,
        windowId: getRawWindowId(windowId),
        content,
      });
    },
    [send],
  );

  const sendDialogFeedback = useCallback(
    (dialogId: string, confirmed: boolean, rememberChoice?: 'once' | 'always' | 'deny_always') => {
      send({ type: ClientEventType.DIALOG_FEEDBACK, dialogId, confirmed, rememberChoice });
    },
    [send],
  );

  const sendToastAction = useCallback(
    (toastId: string, eventId: string) => {
      send({ type: ClientEventType.TOAST_ACTION, toastId, eventId });
    },
    [send],
  );

  const sendUserPromptResponse = useCallback(
    (promptId: string, selectedValues?: string[], text?: string, dismissed?: boolean) => {
      send({
        type: ClientEventType.USER_PROMPT_RESPONSE,
        promptId,
        selectedValues,
        text,
        dismissed,
      });
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
        type: ClientEventType.COMPONENT_ACTION,
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
    send({ type: ClientEventType.INTERRUPT });
  }, [send]);

  const reset = useCallback(() => {
    send({ type: ClientEventType.RESET });
    useDesktopStore.getState().resetDesktop();
  }, [send]);

  const setProvider = useCallback(
    (provider: 'claude' | 'codex') => {
      send({ type: ClientEventType.SET_PROVIDER, provider });
    },
    [send],
  );

  const interruptAgent = useCallback(
    (agentId: string) => {
      send({ type: ClientEventType.INTERRUPT_AGENT, agentId });
    },
    [send],
  );

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePendingEventDrainer({ send, sendComponentAction, addCliEntry });
  useMonitorSync();

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
    sendUserPromptResponse,
    interrupt,
    interruptAgent,
    setProvider,
    reset,
  };
}
