/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import {
  useDesktopStore,
  handleAppProtocolRequest,
  handleVerbSubscriptionUpdate,
  resendAppProtocolReady,
} from '@/store';
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
  drainPendingQueues,
  useMonitorSync,
} from './use-agent-connection';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';
// Window IDs in the store are opaque handles — send as-is to server.
import { captureMonitorScreenshot } from '@/lib/captureMonitorScreenshot';
import { refreshStaleIframeTokens } from '@/lib/iframeTokenRefresh';

let sessionCheckDone = false;

function buildWsUrl(): string {
  const state = useDesktopStore.getState();
  return buildWsUrlFromApi(state.sessionId, state.activeMonitorId);
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
    setMonitors,
    updateCliStreaming,
    finalizeCliStreaming,
    addCliEntry,
    restoreCliHistory,
    incrementSubagentCount,
    decrementSubagentCount,
    trackMessage,
    acceptMessage,
    queueMessage,
    failMessage,
    clearAllMessageStatuses,
    enqueueOutbox,
    settleOutbox,
    applySnapshot,
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

  /**
   * Put an event on the wire, and say whether it got there.
   *
   * The return value is the whole point. This used to return nothing and swallow a closed
   * socket with a `console.warn`, so every caller was structurally incapable of noticing
   * that the thing it had just "sent" was never sent — including the one that had already
   * consumed the user's drawing to build it.
   */
  const send = useCallback((event: ClientEvent): boolean => {
    if (!sendEvent(wsManager, event)) return false;
    addDebugEntry({ direction: 'out', type: event.type, data: event });
    return true;
  }, []);

  /**
   * Resend everything the server has not acknowledged.
   *
   * Safe to call repeatedly: the server dedups by message id, so a message that did land
   * before the socket died is acked a second time rather than run a second time.
   */
  const flushOutbox = useCallback(() => {
    const store = useDesktopStore.getState();
    for (const entry of store.pendingOutbox()) {
      if (send(entry.event)) store.trackMessage(entry.messageId, 'sent');
    }
  }, [send]);

  /**
   * Say everything the server may have missed while we were apart.
   *
   * That includes what our iframes already told us but only ever told the server once: App
   * Protocol readiness lives in the server's memory, and a restarted server has a session,
   * a monitor and a window but no idea the app inside it ever registered — so it refuses
   * every app_query/app_command against that window, permanently, until the tab is
   * reloaded. We witnessed the registration and the iframe is still mounted; re-announcing
   * is cheap and idempotent server-side.
   */
  const flushPending = useCallback(() => {
    drainPendingQueues({ send, addCliEntry });
    resendAppProtocolReady();
    flushOutbox();
  }, [send, flushOutbox, addCliEntry]);

  const resync = useCallback(() => {
    send({ type: ClientEventType.RESYNC });
  }, [send]);

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
          setMonitors,
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
          failMessage,
          settleOutbox,
          clearAllMessageStatuses,
          applySnapshot,
          flushPending,
          resync,
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
        const activeMonitorId = useDesktopStore.getState().activeMonitorId;
        sendEvent(wsManager, {
          type: ClientEventType.SUBSCRIBE_MONITOR,
          monitorId: activeMonitorId,
        });
      },
      onMessage: handleMessage,
      onClose: () => {
        setIsConnecting(false);
        setConnectionStatus('disconnected');
        // The socket dropped under us. Whatever those agents were doing, we are no longer
        // hearing about it — and the spinner they drive used to run until the tab was
        // reloaded, because only the *explicit* disconnect() path cleared them. If they are
        // still alive, the snapshot on reattach says so and puts them back.
        clearAllAgents();
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

      const event: ClientEvent = {
        type: ClientEventType.USER_MESSAGE,
        messageId,
        content,
        monitorId,
        interactions: interactions.length > 0 ? interactions : undefined,
        target,
      };

      // Into the outbox *before* the wire. The drawing and the images have already been
      // consumed out of the store to build this event — if the send fails and nothing is
      // holding the event, they are gone for good, and the CLI panel is left claiming the
      // user asked for something that was never asked. The outbox is what holds them: the
      // message stays there, attachments and all, until the server acks it, and is resent
      // on reconnect.
      enqueueOutbox(messageId, event);
      trackMessage(messageId, send(event) ? 'sent' : 'unsent');
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
