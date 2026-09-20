/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import {
  useDesktopStore,
  handleAppProtocolRequest,
  handleVerbSubscriptionUpdate,
  handleStreamFrame,
  resendAppProtocolReady,
} from '@/store';
import type { ClientEvent, AppProtocolRequest, StreamFrame } from '@/types';
import { ClientEventType, ServerEventType } from '@/types';
import {
  wsManager,
  sendEvent,
  openSocket,
  markAttached,
  retryNow,
  dispatchServerEvent,
  generateActionId,
  generateMessageId,
  usePendingEventDrainer,
  drainPendingQueues,
  useMonitorSync,
  monitorSubscription,
  useClientPresence,
  clientPresence,
  createLivenessProbe,
  replaceDeadSocket,
} from './use-agent-connection';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';
// Window IDs in the store are opaque handles — send as-is to server.
import { captureMonitorScreenshot } from '@/lib/captureMonitorScreenshot';
import { refreshStaleIframeTokens } from '@/lib/iframeTokenRefresh';

let sessionCheckDone = false;

/**
 * The current `connect`, for the module-level probe below to reach.
 *
 * The probe cannot be built inside the hook: it has to outlive every re-render (a
 * deadline that restarted whenever a callback identity changed would never expire) and
 * `connect` is a `useCallback`. Kept in sync by an effect; the probe only ever fires
 * seconds after a resume, by which time it is assigned.
 */
let reconnectNow: () => void = () => {};

/**
 * Hangs up on a socket that came back from a freeze and then said nothing.
 *
 * See `liveness-probe.ts` for why `readyState` cannot answer this and why the reconnect
 * path never noticed on its own. The socket identity check is what makes a late deadline
 * harmless — by the time it fires we may already be on a different, healthy connection.
 */
const livenessProbe = createLivenessProbe((probed) => {
  if (wsManager.ws !== probed) return;
  useDesktopStore.getState().setConnectionStatus('connecting');
  replaceDeadSocket(wsManager, reconnectNow);
});

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
        useDesktopStore.getState().setRestorePrompt({
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

  const handleStreamFrameCb = useCallback(
    (windowId: string, subscriptionId: string, frame: StreamFrame) => {
      handleStreamFrame(windowId, subscriptionId, frame);
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
    useDesktopStore.getState().addDebugEntry({ direction: 'out', type: event.type, data: event });
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
    drainPendingQueues({ send, addCliEntry: useDesktopStore.getState().addCliEntry });
    resendAppProtocolReady();
    flushOutbox();
  }, [send, flushOutbox]);

  const resync = useCallback(() => {
    send({ type: ClientEventType.RESYNC });
  }, [send]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Any frame at all proves there is still a server on the other end, which is the
      // only thing the probe was waiting to hear.
      livenessProbe.disarm();
      try {
        const message = JSON.parse(event.data);
        // Attachment — not transport open — is what proves the connection made progress.
        if (message?.type === ServerEventType.SESSION_ATTACHED) {
          markAttached(wsManager);
        }
        const store = useDesktopStore.getState();
        dispatchServerEvent(message, {
          applyActions: store.applyActions,
          setIsConnecting,
          setConnectionStatus: store.setConnectionStatus,
          setConnectionError: store.setConnectionError,
          setSession: store.setSession,
          setAttachment: store.setAttachment,
          checkForPreviousSession,
          setMonitors: store.setMonitors,
          refreshStaleIframeTokens,
          addDebugEntry: store.addDebugEntry,
          setAgentActive: store.setAgentActive,
          clearAgent: store.clearAgent,
          registerWindowAgent: store.registerWindowAgent,
          updateWindowAgentStatus: store.updateWindowAgentStatus,
          updateCliStreaming: store.updateCliStreaming,
          appendCliStreaming: store.appendCliStreaming,
          finalizeCliStreaming: store.finalizeCliStreaming,
          addCliEntry: store.addCliEntry,
          handleAppProtocolRequest: handleAppProtocolRequestCb,
          handleVerbSubscriptionUpdate: handleVerbSubscriptionUpdateCb,
          handleStreamFrame: handleStreamFrameCb,
          restoreCliHistory: store.restoreCliHistory,
          acceptMessage: store.acceptMessage,
          queueMessage: store.queueMessage,
          failMessage: store.failMessage,
          settleOutbox: store.settleOutbox,
          clearMessageStatus: store.clearMessageStatus,
          clearAllMessageStatuses: store.clearAllMessageStatuses,
          applySnapshot: store.applySnapshot,
          flushPending,
          resync,
          incrementSubagentCount: store.incrementSubagentCount,
          decrementSubagentCount: store.decrementSubagentCount,
        });
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    },
    [
      checkForPreviousSession,
      handleAppProtocolRequestCb,
      handleVerbSubscriptionUpdateCb,
      handleStreamFrameCb,
      flushPending,
      resync,
    ],
  );

  const connect = useCallback(() => {
    // Any call to connect() is an intent to be online, so it lifts the stop set by
    // disconnect(); without this a reconnect after an explicit disconnect would be
    // refused by shouldReconnect() forever.
    wsManager.stopped = false;
    const socket = openSocket(wsManager, () => new WebSocket(buildWsUrl()), {
      onOpen: () => {
        // A completed handshake is a live peer; a probe armed against a socket that was
        // still connecting has its answer.
        livenessProbe.disarm();
        sendEvent(wsManager, monitorSubscription(useDesktopStore.getState().activeMonitorId));
        // Presence is per connection and the server forgets it on close, so say it again.
        sendEvent(wsManager, clientPresence());
      },
      onMessage: handleMessage,
      onClose: () => {
        // The socket declared itself dead, so there is nothing left to probe for — and
        // the backoff below owns the reconnect from here.
        livenessProbe.disarm();
        setIsConnecting(false);
        useDesktopStore.getState().setConnectionStatus('disconnected');
        // The socket dropped under us. Whatever those agents were doing, we are no longer
        // hearing about it — and the spinner they drive used to run until the tab was
        // reloaded, because only the *explicit* disconnect() path cleared them. If they are
        // still alive, the snapshot on reattach says so and puts them back.
        useDesktopStore.getState().clearAllAgents();
      },
      onError: () => {
        useDesktopStore.getState().setConnectionStatus('error', 'Connection failed');
      },
      reconnect: () => connect(),
    });
    if (!socket) return;

    setIsConnecting(true);
    useDesktopStore.getState().setConnectionStatus('connecting');
  }, [handleMessage]);

  const disconnect = useCallback(() => {
    if (wsManager.reconnectTimeout) {
      clearTimeout(wsManager.reconnectTimeout);
      wsManager.reconnectTimeout = null;
    }
    wsManager.nextRetryAt = null;
    wsManager.stopped = true;

    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      wsManager.ws.close(1000, 'User disconnect');
      // Deregistering here makes the socket's own onclose a no-op (it is no longer the
      // current socket), so this path owns the teardown state it used to inherit.
      wsManager.ws = null;
      wsManager.notify();
    }

    setIsConnecting(false);
    const store = useDesktopStore.getState();
    store.setConnectionStatus('disconnected');
    store.clearAllAgents();
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

      const store = useDesktopStore.getState();
      const drawing = store.consumeDrawing();
      const images = store.consumeAttachedImages();
      const messageId = generateMessageId();
      const monitorId = store.activeMonitorId;
      // CLI-panel "act as me" toggle — route to the session agent (the user's
      // deputy) only while the CLI panel is open; the main palette stays on the
      // monitor agent.
      const { cliMode, cliTarget } = store;
      const target = cliMode && cliTarget === 'session' ? 'session' : undefined;
      store.addCliEntry({ type: 'user', content, monitorId });

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
      store.enqueueOutbox(messageId, event);
      store.trackMessage(messageId, send(event) ? 'sent' : 'unsent');
    },
    [send],
  );

  const sendWindowMessage = useCallback(
    (windowId: string, content: string) => {
      const messageId = generateMessageId();
      useDesktopStore.getState().trackMessage(messageId);
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

  /**
   * Answer a prompt an agent is parked on.
   *
   * Returns whether the answer reached the wire, because the caller has to know: the box
   * is the only copy of an answer that never got sent, and taking it down anyway left the
   * user certain they had replied while the agent waited out its full deadline.
   *
   * Deliberately *not* held in the outbox, unlike a user message. The outbox settles on a
   * `MESSAGE_ACCEPTED`/`MESSAGE_QUEUED`/`ERROR` naming a message id, and a prompt answer
   * has neither an id nor an ack — it would sit there and be resent on every reconnect
   * forever. Recovery is the snapshot instead: the server still holds the prompt as a live
   * surface until it is answered, so reconnecting re-shows it.
   *
   * The answer is also echoed into the asking monitor's CLI history. Without it the tmux
   * view showed the agent acting on something the transcript never recorded.
   */
  const sendUserPromptResponse = useCallback(
    (
      prompt: { id: string; title: string; monitorId?: string },
      answer: { selectedValues?: string[]; text?: string; dismissed?: boolean },
    ): boolean => {
      const delivered = send({
        type: ClientEventType.USER_PROMPT_RESPONSE,
        promptId: prompt.id,
        selectedValues: answer.selectedValues,
        text: answer.text,
        dismissed: answer.dismissed,
      });
      if (!delivered) return false;

      const parts = [
        answer.selectedValues?.length ? answer.selectedValues.join(', ') : '',
        answer.text ?? '',
      ].filter(Boolean);
      const store = useDesktopStore.getState();
      store.addCliEntry({
        type: 'user',
        content: `[${prompt.title}] ${answer.dismissed ? '(skipped)' : parts.join(' — ')}`,
        // A prompt from before this field existed, or from an agent with no monitor at
        // all, is echoed where the user is looking rather than into pane 0 by default.
        monitorId: prompt.monitorId ?? store.activeMonitorId,
      });
      return true;
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

  /**
   * Clear the context of one monitor — the one the caller is looking at.
   *
   * Both halves have to be scoped together or they disagree about what was reset: the
   * event tells the server which agent tree to forget, `resetDesktop` clears the matching
   * client state. Omitting `monitorId` keeps the session-wide behavior for callers that
   * have no monitor in hand.
   *
   * Into the outbox first, for the same reason a user message goes there: `send` returning
   * true means the frame reached *our* end of the socket, and a phone coming back from
   * another app routinely holds one whose peer is long gone (see `recoverAfterResume`).
   * The local clear below then ran against a server that had never heard of the reset —
   * the transcript emptied, the toast appeared, and the next message was answered by the
   * conversation the button exists to end. The outbox holds it until the server acks it and
   * resends it on the next attach; the server dedups, so a reset that did land is not run
   * twice.
   *
   * The desktop is still cleared straight away rather than on the ack. The ack is
   * ordinarily immediate, but `resetSession` is not, and a reset button that leaves the old
   * transcript on screen while an agent is rebuilt reads as a button that did nothing.
   */
  const reset = useCallback(
    (monitorId?: string) => {
      const messageId = generateMessageId();
      const store = useDesktopStore.getState();
      const event: ClientEvent = { type: ClientEventType.RESET, monitorId, messageId };
      store.enqueueOutbox(messageId, event);
      send(event);
      store.resetDesktop(monitorId);
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
    reconnectNow = connect;
  }, [connect]);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Put the desktop back together after the tab was not running.
   *
   * Exactly what reattach does, for the case that never reattaches: a tab frozen with its
   * socket intact comes back to a server that may have spent the whole time talking past
   * it. Both halves are idempotent — re-announcing readiness for a window the server
   * already knows is a no-op, and the snapshot is authoritative by design.
   *
   * And then we check that any of it landed. "Its socket intact" is what our end of the
   * socket claims, not a fact: a phone that spent ten minutes in another app usually
   * comes back holding a connection whose peer is long gone, where the resync above goes
   * out into nothing and no `onclose` will ever arrive to start a reconnect. The socket
   * owes us a `SNAPSHOT` for that resync, so we hold it to a deadline —
   * `liveness-probe.ts` has the rest.
   */
  const recoverAfterResume = useCallback(() => {
    const socket = wsManager.ws;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      flushPending();
      resync();
    } else if (socket.readyState !== WebSocket.CONNECTING) {
      // CLOSING or CLOSED: the close path already owns the retry.
      return;
    }
    // CONNECTING gets the same deadline with nothing sent: a handshake interrupted by the
    // freeze can sit there forever, and `openSocket` refuses to replace a connecting
    // socket, so nothing else would ever clear it.
    livenessProbe.arm(socket);
  }, [flushPending, resync]);

  useClientPresence(recoverAfterResume);

  usePendingEventDrainer({
    send,
    sendComponentAction,
    addCliEntry: useDesktopStore.getState().addCliEntry,
  });
  useMonitorSync();

  /** Cancel the pending backoff and reconnect immediately. */
  const retryConnection = useCallback(() => retryNow(wsManager, connect), [connect]);

  return {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    retryConnection,
    sendMessage,
    sendWindowMessage,
    sendComponentAction,
    sendDialogFeedback,
    sendToastAction,
    sendUserPromptResponse,
    interrupt,
    interruptAgent,
    reset,
  };
}
