/**
 * The socket's life: opening it, reading it, noticing when it has died, replacing it.
 *
 * Module state, not component state, because there is exactly one socket. This used to
 * be a hook, which meant five live components each installed a full set of listeners and
 * store subscriptions against the same singleton — five `CLIENT_PRESENCE` frames per
 * backgrounding, five `RESYNC`s per resume, five authoritative snapshots to apply. It
 * stayed correct only by accident: `createConsumeQueue` empties in one synchronous step,
 * so the four redundant drains found nothing, and `openSocket`'s `readyState` guard
 * refused the four extra sockets. Neither accident was designed. `useAgentConnectionOwner`
 * in `../useAgentConnection.ts` is now the one mount point.
 */
import { useDesktopStore } from '@/store';
import type { AppProtocolRequest, StreamFrame } from '@/types';
import { ServerEventType } from '@/types';
import { handleAppProtocolRequest, handleVerbSubscriptionUpdate, handleStreamFrame } from '@/store';
import {
  wsManager,
  sendEvent,
  openSocket,
  markAttached,
  retryNow,
  replaceDeadSocket,
} from './transport-manager';
import { dispatchServerEvent } from './server-event-dispatcher';
import { monitorSubscription, clientPresence } from './frames';
import { createLivenessProbe } from './liveness-probe';
import { flushPending, resync } from './commands';
import { apiFetch, buildWsUrl as buildWsUrlFromApi } from '@/lib/api';

let sessionCheckDone = false;

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
  replaceDeadSocket(wsManager, connect);
});

function buildWsUrl(): string {
  const state = useDesktopStore.getState();
  return buildWsUrlFromApi(state.sessionId, state.activeMonitorId);
}

async function checkForPreviousSession(currentSessionId: string): Promise<void> {
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
}

function handleMessage(event: MessageEvent): void {
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
      setConnectionStatus: store.setConnectionStatus,
      setConnectionError: store.setConnectionError,
      setSession: store.setSession,
      setAttachment: store.setAttachment,
      checkForPreviousSession,
      setMonitors: store.setMonitors,
      setAgentActive: store.setAgentActive,
      clearAgent: store.clearAgent,
      registerWindowAgent: store.registerWindowAgent,
      updateWindowAgentStatus: store.updateWindowAgentStatus,
      updateCliStreaming: store.updateCliStreaming,
      appendCliStreaming: store.appendCliStreaming,
      finalizeCliStreaming: store.finalizeCliStreaming,
      addCliEntry: store.addCliEntry,
      handleAppProtocolRequest: (
        requestId: string,
        windowId: string,
        request: AppProtocolRequest,
        timeoutMs?: number,
      ) => handleAppProtocolRequest(requestId, windowId, request, timeoutMs),
      handleVerbSubscriptionUpdate: (windowId: string, subscriptionId: string, uri: string) =>
        handleVerbSubscriptionUpdate(windowId, subscriptionId, uri),
      handleStreamFrame: (windowId: string, subscriptionId: string, frame: StreamFrame) =>
        handleStreamFrame(windowId, subscriptionId, frame),
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
}

export function connect(): void {
  // Any call to connect() is an intent to be online, so it lifts the stop set by
  // disconnect(); without this a reconnect after an explicit disconnect would be
  // refused by shouldReconnect() forever.
  wsManager.stopped = false;
  const socket = openSocket(wsManager, () => new WebSocket(buildWsUrl()), {
    onOpen: () => {
      // An armed resume probe waits for a server frame, not just the TCP handshake.
      sendEvent(wsManager, monitorSubscription(useDesktopStore.getState().activeMonitorId));
      // Presence is per connection and the server forgets it on close, so say it again.
      sendEvent(wsManager, clientPresence());
    },
    onMessage: handleMessage,
    onClose: () => {
      // The socket declared itself dead, so there is nothing left to probe for — and
      // the backoff below owns the reconnect from here.
      livenessProbe.disarm();
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

  useDesktopStore.getState().setConnectionStatus('connecting');
}

export function disconnect(): void {
  livenessProbe.disarm();
  if (wsManager.reconnectTimeout !== null) {
    clearTimeout(wsManager.reconnectTimeout);
    wsManager.reconnectTimeout = null;
  }
  wsManager.nextRetryAt = null;
  wsManager.stopped = true;

  // Detach before closing, including a handshake still in progress. Late callbacks
  // must not bring an explicitly disconnected desktop back online.
  const socket = wsManager.ws;
  wsManager.ws = null;
  wsManager.attached = false;
  wsManager.notify();
  try {
    socket?.close(1000, 'User disconnect');
  } catch {
    // The socket is already detached; teardown must still clear the desktop state.
  }

  const store = useDesktopStore.getState();
  store.setConnectionStatus('disconnected');
  store.clearAllAgents();
}

/** Cancel the pending backoff and reconnect immediately. */
export function retryConnection(): void {
  livenessProbe.disarm();
  wsManager.stopped = false;
  replaceDeadSocket(wsManager, connect);
}

/**
 * Put the desktop back together after the tab was not running.
 *
 * Exactly what reattach does, for the case that never reattaches: a tab frozen with its
 * socket intact comes back to a server that may have spent the whole time talking past
 * it. Both halves are idempotent — re-announcing readiness for a window the server
 * already knows is a no-op, and the snapshot is authoritative by design.
 *
 * Plus the one frame reattach sends that resync does not: which monitor this tab is on,
 * at what size, in which layout. The server keeps that per monitor, not per tab, and
 * nothing guarantees it still holds this tab's answer after a freeze — a rotation the
 * frozen page never reported, or another connection's report in between. Sent first, so
 * a window a queued message creates is sized for the screen it will appear on.
 *
 * And then we check that any of it landed. "Its socket intact" is what our end of the
 * socket claims, not a fact: a phone that spent ten minutes in another app usually
 * comes back holding a connection whose peer is long gone, where the resync above goes
 * out into nothing and no `onclose` will ever arrive to start a reconnect. The socket
 * owes us a `SNAPSHOT` for that resync, so we hold it to a deadline —
 * `liveness-probe.ts` has the rest.
 */
export function recoverAfterResume(): void {
  if (wsManager.stopped) return;
  const socket = wsManager.ws;
  if (!socket) {
    retryNow(wsManager, connect);
    return;
  }
  if (socket.readyState === WebSocket.OPEN && wsManager.attached) {
    sendEvent(wsManager, monitorSubscription(useDesktopStore.getState().activeMonitorId));
    flushPending();
    resync();
  } else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    // A close handshake can stall just like an open one. Do not wait for onclose.
    replaceDeadSocket(wsManager, connect);
    return;
  }
  // CONNECTING gets the same deadline with nothing sent: a handshake interrupted by the
  // freeze can sit there forever, and `openSocket` refuses to replace a connecting
  // socket, so nothing else would ever clear it.
  livenessProbe.arm(socket);
}
