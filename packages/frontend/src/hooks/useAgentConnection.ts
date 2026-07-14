/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import { useDesktopStore, handleAppProtocolRequest, handleVerbSubscriptionUpdate } from '@/store';
import type { ClientEvent, AppProtocolRequest } from '@/types';
import { ClientEventType, ServerEventType } from '@/types';
import {
  wsManager,
  MAX_RECONNECT_ATTEMPTS,
  sendEvent,
  openSocket,
  markAttached,
  dispatchServerEvent,
  generateActionId,
  generateMessageId,
  usePendingEventDrainer,
  useMonitorSync,
} from './use-agent-connection';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';
// Window IDs in the store are opaque handles — send as-is to server.
import { captureMonitorScreenshot } from '@/lib/captureMonitorScreenshot';
import { refreshStaleIframeTokens } from '@/lib/iframeTokenRefresh';

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
    setAttachment,
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
    (requestId: string, windowId: string, request: AppProtocolRequest, timeoutMs?: number) => {
      handleAppProtocolRequest(requestId, windowId, request, timeoutMs);
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
        // Attachment — not transport open — is what proves the connection made progress.
        if (message?.type === ServerEventType.SESSION_ATTACHED) {
          markAttached(wsManager);
        }
        dispatchServerEvent(message, {
          applyActions,
          setIsConnecting,
          setConnectionStatus,
          setSession,
          setAttachment,
          checkForPreviousSession,
          refreshStaleIframeTokens,
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
    const socket = openSocket(wsManager, () => new WebSocket(buildWsUrl()), {
      onOpen: () => {
        const activeMonitorId = useDesktopStore.getState().activeMonitorId ?? '0';
        sendEvent(wsManager, {
          type: ClientEventType.SUBSCRIBE_MONITOR,
          monitorId: activeMonitorId,
        });
      },
      onMessage: handleMessage,
      onClose: () => {
        setIsConnecting(false);
        setConnectionStatus('disconnected');
      },
      onError: () => {
        setConnectionStatus('error', 'Connection failed');
      },
      reconnect: () => connect(),
    });
    if (!socket) return;

    setIsConnecting(true);
    setConnectionStatus('connecting');
  }, [handleMessage, setConnectionStatus]);

  const disconnect = useCallback(() => {
    if (wsManager.reconnectTimeout) {
      clearTimeout(wsManager.reconnectTimeout);
      wsManager.reconnectTimeout = null;
    }
    wsManager.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;

    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      wsManager.ws.close(1000, 'User disconnect');
      // Deregistering here makes the socket's own onclose a no-op (it is no longer the
      // current socket), so this path owns the teardown state it used to inherit.
      wsManager.ws = null;
      wsManager.notify();
    }

    setIsConnecting(false);
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
      // CLI-panel "act as me" toggle — route to the session agent (the user's
      // deputy) only while the CLI panel is open; the main palette stays on the
      // monitor agent. See docs/session_agent_browser_design.md §6.
      const { cliMode, cliTarget } = useDesktopStore.getState();
      const target = cliMode && cliTarget === 'session' ? 'session' : undefined;
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
        target,
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
        windowId: windowId,
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
        windowId: windowId,
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
