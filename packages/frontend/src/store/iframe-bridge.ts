/**
 * Iframe Bridge - all communication between the desktop store and iframe windows.
 *
 * Covers: window capture (direct WS send), App Protocol relay, verb subscription
 * forwarding, iframe message routing, windows SDK handler, and notification broadcasting.
 */
import type {
  AppProtocolPostMessage,
  AppProtocolRequest,
  AppProtocolResponse,
  StreamFrame,
} from '@yaar/shared';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { ClientEventType } from '@/types';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { resolveWindowKey } from './helpers';
// Circular import — safe because useDesktopStore is only accessed at runtime (live ESM binding)
import { useDesktopStore } from './desktop';

/**
 * How long past the server's own deadline the relay keeps listening for a reply.
 *
 * Only ever used to unhook a listener, never to declare a timeout — so it is generous on
 * purpose: an app whose reply is merely slow should still be heard, and the server has
 * already spoken for itself by then.
 */
const LISTENER_GRACE_MS = 5_000;

/**
 * Get the target origin for postMessage to an iframe.
 * srcdoc/about:blank iframes have a "null" origin, requiring '*'.
 */
function getIframeTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    const origin = iframe.contentWindow?.origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    // Cross-origin access blocked
  }
  return '*';
}

/**
 * Windows whose iframe has announced `yaar:app-ready` — i.e. called `app.register()`.
 *
 * The server tracks App Protocol readiness in its own WindowStateRegistry, fed by this
 * handshake, which each iframe performs exactly once at registration. The session survives
 * a server restart; that one-shot handshake does not, so a restarted server knew of the
 * window but not that its app was ready, and every app_query/app_command against it failed
 * with "App did not register with the App Protocol (timeout)" until the tab was reloaded.
 *
 * The desktop witnessed the registration and the iframe is still mounted, so it can simply
 * say it again on reattach — no round trip into the iframes needed. See
 * `resendAppProtocolReady`.
 */
const registeredAppWindows = new Set<string>();

/**
 * Re-announce App Protocol readiness for every still-mounted app iframe.
 *
 * Called on reattach (see `flushPending` in useAgentConnection). The server side is
 * idempotent — `setAppProtocol` + `notifyAppReady` — so re-announcing a window the server
 * already knows about is a no-op, and re-announcing one it forgot is the whole point.
 */
export function resendAppProtocolReady() {
  for (const windowId of registeredAppWindows) {
    // Only speak for iframes that are actually still on screen. A window closed while the
    // socket was down would otherwise be announced as ready to a server that has no such
    // window — harmless, but it is a claim we cannot currently witness.
    const el = document.querySelector(
      `[${WINDOW_ID_DATA_ATTR}="${windowId}"]`,
    ) as HTMLElement | null;
    if (!el?.querySelector('iframe')) {
      registeredAppWindows.delete(windowId);
      continue;
    }
    console.debug(`[AppProtocol] Re-announcing readiness for ${windowId}`);
    sendEvent(wsManager, {
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId,
      // The iframe is the same one that registered; it did not remount and has not lost
      // anything, so the server must not replay its commands at it. See AppProtocolReadyEvent.
      reannounce: true,
    });
  }
}

/**
 * Fire-and-forget: notify an iframe app that its window is about to close.
 * Must be called BEFORE the window element is removed from the DOM.
 */
export function notifyIframeClose(windowId: string) {
  registeredAppWindows.delete(windowId);
  const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${windowId}"]`) as HTMLElement | null;
  const iframe = el?.querySelector('iframe') as HTMLIFrameElement | null;
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'yaar:app-close' }, getIframeTargetOrigin(iframe));
  }
}

/**
 * Try capturing iframe content via the postMessage self-capture protocol.
 * Returns a base64 PNG data URL or null if the iframe doesn't respond.
 */
export function tryIframeSelfCapture(
  iframe: HTMLIFrameElement,
  timeoutMs = 2000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(e: MessageEvent) {
      if (
        e.data?.type === 'yaar:capture-response' &&
        e.data.requestId === requestId &&
        e.source === iframe.contentWindow
      ) {
        // Ignore null responses — an upgraded capture handler may still
        // respond with actual image data (e.g. foreignObject DOM capture).
        if (!e.data.imageData) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(e.data.imageData);
      }
    }

    window.addEventListener('message', handler);
    iframe.contentWindow?.postMessage(
      { type: 'yaar:capture-request', requestId },
      getIframeTargetOrigin(iframe),
    );
  });
}

/**
 * Capture a window element as an image and send feedback directly over WebSocket.
 *
 * Sends a postMessage capture request to the iframe. The injected capture
 * script handles canvas and DOM (via foreignObject) capture using the
 * browser's native CSS engine. Feedback is sent directly over WebSocket
 * (bypassing the Zustand queue) to minimize latency.
 */
export async function captureWindow(windowId: string, requestId: string) {
  const sendFeedback = (success: boolean, extra?: { imageData?: string; error?: string }) => {
    sendEvent(wsManager, {
      type: ClientEventType.RENDERING_FEEDBACK,
      requestId,
      windowId,
      renderer: 'capture',
      success,
      ...extra,
    });
  };

  try {
    const el = document.querySelector(
      `[${WINDOW_ID_DATA_ATTR}="${windowId}"]`,
    ) as HTMLElement | null;
    if (!el) {
      sendFeedback(false, { error: 'Window element not found in DOM' });
      return;
    }

    const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
    if (!iframe?.contentWindow) {
      sendFeedback(false, { error: 'No iframe found in window' });
      return;
    }

    const iframeData = await tryIframeSelfCapture(iframe);
    if (iframeData) {
      const base64 = iframeData.replace(/^data:image\/[^;]+;base64,/, '');
      sendFeedback(true, { imageData: base64 });
    } else {
      sendFeedback(false, { error: 'Capture returned empty' });
    }
  } catch (error) {
    sendFeedback(false, { error: error instanceof Error ? error.message : 'Capture failed' });
  }
}

/**
 * Send an App Protocol reply straight down the socket.
 *
 * This is an RPC answer to a server that is already sitting on a deadline for it, so
 * buffering it in the Zustand pending queue buys nothing and can cost everything: a reply
 * that misses its deadline is a corpse, and the server can only report it as the app
 * timing out. (Same reasoning that moved `yaar:app-ready` to a direct send below.) The
 * queue remains only as a fallback for a socket that is down — the server has almost
 * certainly given up by the time it comes back, but a late reply that is logged beats a
 * dropped one.
 */
function sendAppProtocolResponse(
  requestId: string,
  windowId: string,
  response: AppProtocolResponse,
) {
  console.debug(`[AppProtocol] ← reply ${requestId} (${response.kind})`, response);
  const sent = sendEvent(wsManager, {
    type: ClientEventType.APP_PROTOCOL_RESPONSE,
    requestId,
    windowId,
    response,
  });
  if (!sent) {
    console.debug(`[AppProtocol] socket down, queueing reply ${requestId}`);
    useDesktopStore.getState().addPendingAppProtocolResponse({ requestId, windowId, response });
  }
}

/**
 * Handle an App Protocol request by forwarding it to the target iframe via postMessage,
 * then sending the app's response back over the socket.
 */
export function handleAppProtocolRequest(
  requestId: string,
  windowId: string,
  request: AppProtocolRequest,
  timeoutMs?: number,
) {
  console.debug(`[AppProtocol] → request ${requestId} (${request.kind}) for ${windowId}`, request);
  const state = useDesktopStore.getState();
  const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
  const key = resolveWindowKey(state.windows, windowId, monitorId);

  const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;
  if (!el) {
    sendAppProtocolResponse(requestId, windowId, {
      kind: request.kind,
      error: 'Window element not found',
    } as AppProtocolResponse);
    return;
  }

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentWindow) {
    sendAppProtocolResponse(requestId, windowId, {
      kind: request.kind,
      error: 'No iframe found in window',
    } as AppProtocolResponse);
    return;
  }

  // Build postMessage based on request kind
  let msg: Record<string, unknown>;
  if (request.kind === 'manifest') {
    msg = { type: 'yaar:app-manifest-request', requestId };
  } else if (request.kind === 'query') {
    msg = { type: 'yaar:app-query-request', requestId, stateKey: request.stateKey };
  } else {
    msg = {
      type: 'yaar:app-command-request',
      requestId,
      command: request.command,
      params: request.params,
    };
  }

  // The server's PendingStore deadline is the only timeout that counts. This timer used to
  // race it with a clock of its own, manufacturing a second, indistinguishable "Timeout
  // waiting for app response" string — and being the leg most exposed to Chrome's hidden-tab
  // throttling, it was routinely the one that fired *late*: a 5s timer landing at ~11s, well
  // past a deadline the server had already given up on, so the reply arrived as a corpse and
  // the app got blamed for it. It no longer produces a response at all. It exists only to
  // unhook the listener (and say so), a grace period past the server's deadline so a reply
  // still in flight is never cut off by us.
  const deadlineMs = timeoutMs ?? 5000;
  const timeoutId = setTimeout(() => {
    window.removeEventListener('message', handler);
    console.debug(
      `[AppProtocol] no reply for ${requestId} within ${(deadlineMs / 1000).toFixed(0)}s ` +
        `(+grace); the app never answered. The server's own deadline governs.`,
    );
  }, deadlineMs + LISTENER_GRACE_MS);

  function handler(e: MessageEvent) {
    if (!e.data?.requestId || e.data.requestId !== requestId) return;
    const msg = e.data as AppProtocolPostMessage;
    if (!msg.type?.startsWith('yaar:app-')) return;

    // Validate that the response came from the expected iframe
    if (e.source !== iframe!.contentWindow) {
      console.warn(
        `[AppProtocol] Ignoring response for ${requestId}: source mismatch (possible spoofing)`,
      );
      return;
    }

    console.debug(`[AppProtocol] reply received from iframe for ${requestId} (${msg.type})`);
    clearTimeout(timeoutId);
    window.removeEventListener('message', handler);

    let response: AppProtocolResponse;
    if (msg.type === 'yaar:app-manifest-response') {
      if (msg.manifest == null && msg.error == null) {
        console.warn(`[AppProtocol] Manifest response missing both manifest and error fields`);
      }
      response = { kind: 'manifest', manifest: msg.manifest, error: msg.error };
    } else if (msg.type === 'yaar:app-query-response') {
      if (msg.data === undefined && msg.error == null) {
        console.warn(`[AppProtocol] Query response missing both data and error fields`);
      }
      response = { kind: 'query', data: msg.data, error: msg.error };
    } else if (msg.type === 'yaar:app-command-response') {
      if (msg.result === undefined && msg.error == null) {
        console.warn(`[AppProtocol] Command response missing both result and error fields`);
      }
      response = { kind: 'command', result: msg.result, error: msg.error };
    } else {
      console.warn(`[AppProtocol] Unknown response type: ${msg.type}`);
      response = {
        kind: request.kind,
        error: `Unknown response type: ${msg.type}`,
      } as AppProtocolResponse;
    }

    sendAppProtocolResponse(requestId, windowId, response);
  }

  window.addEventListener('message', handler);
  iframe.contentWindow.postMessage(msg, getIframeTargetOrigin(iframe));
  console.debug(`[AppProtocol] postMessage sent to iframe for ${requestId} (${msg.type})`);
}

/**
 * Forward a verb subscription update to the target iframe via postMessage.
 * The iframe SDK listens for 'yaar:subscription-update' messages and
 * invokes the registered callback for the matching subscriptionId.
 */
export function handleVerbSubscriptionUpdate(
  windowId: string,
  subscriptionId: string,
  uri: string,
): void {
  const state = useDesktopStore.getState();
  const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
  const key = resolveWindowKey(state.windows, windowId, monitorId);

  const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;
  if (!el) return;

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentWindow) return;

  iframe.contentWindow.postMessage(
    {
      type: 'yaar:subscription-update',
      subscriptionId,
      uri,
    },
    getIframeTargetOrigin(iframe),
  );
}

/**
 * Deliver one stream frame to the subscribing iframe.
 *
 * Mirror of {@link handleVerbSubscriptionUpdate} — same window resolution — but
 * carries the whole frame payload instead of a bare change ping.
 */
export function handleStreamFrame(
  windowId: string,
  subscriptionId: string,
  frame: StreamFrame,
): void {
  const state = useDesktopStore.getState();
  const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
  const key = resolveWindowKey(state.windows, windowId, monitorId);

  const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;
  if (!el) return;

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentWindow) return;

  iframe.contentWindow.postMessage(
    {
      type: 'yaar:stream-frame',
      subscriptionId,
      frame,
    },
    getIframeTargetOrigin(iframe),
  );
}

/** Tracks in-flight text drag from an iframe. */
let _iframeDragSource: { windowId: string; text: string } | null = null;

/** Check if an iframe text drag is in progress. */
export function getIframeDragSource() {
  return _iframeDragSource;
}

/** Consume (read + clear) the iframe drag source. */
export function consumeIframeDragSource() {
  const src = _iframeDragSource;
  _iframeDragSource = null;
  return src;
}

/**
 * Register iframe message handlers via the centralized router.
 *
 * Handles: yaar:app-ready, yaar:app-interaction, yaar:click,
 * yaar:contextmenu, yaar:drag-start.
 */
export function initIframeMessageHandlers() {
  iframeMessages.on('yaar:app-ready', (ctx) => {
    if (!ctx.source) return;
    const { windowId } = ctx.source;
    // Remember it: the iframe performs this handshake exactly once, but the server may
    // need to hear it more than once (see resendAppProtocolReady).
    registeredAppWindows.add(windowId);
    console.debug(`[AppProtocol] app registered: ${windowId}`);
    // Send APP_PROTOCOL_READY immediately over WebSocket, bypassing the
    // Zustand pending queue to eliminate the subscription-drain latency.
    sendEvent(wsManager, { type: ClientEventType.APP_PROTOCOL_READY, windowId });
  });

  iframeMessages.on('yaar:app-interaction', (ctx) => {
    if (!ctx.source) return;
    const content = ctx.data.content;
    if (typeof content !== 'string' || !content) return;
    const instructions =
      typeof ctx.data.instructions === 'string' ? ctx.data.instructions : undefined;
    useDesktopStore.getState().addPendingAppInteraction({
      windowId: ctx.source.windowId,
      content,
      instructions,
      toMonitor: !!ctx.data.toMonitor,
    });
  });

  iframeMessages.on('yaar:app-event', (ctx) => {
    if (!ctx.source) return;
    const channel = ctx.data.channel;
    if (typeof channel !== 'string' || !channel) return;
    useDesktopStore.getState().addPendingAppEvent({
      windowId: ctx.source.windowId,
      channel,
      payload: ctx.data.payload,
    });
  });

  // yaar:click — no-op (context menu removed)

  iframeMessages.on('yaar:drag-start', (ctx) => {
    if (!ctx.source) return;
    const text = String(ctx.data.text ?? '').trim();
    if (!text) return;
    _iframeDragSource = { windowId: ctx.source.windowId, text };
  });
}

/**
 * Handle yaar:window-read and yaar:window-list requests from iframes.
 *
 * This is a request-response pattern: iframe asks, parent responds.
 * Read-only — iframes can read other windows' content but not modify them.
 */
export function initWindowsSdkHandler() {
  window.addEventListener('message', async (e: MessageEvent) => {
    const type = e.data?.type;
    if (type !== 'yaar:window-read' && type !== 'yaar:window-list') return;

    const requestId = e.data.requestId;
    if (!requestId) return;

    // Find the source iframe to respond to
    const src = e.source as Window | null;
    if (!src) return;

    if (type === 'yaar:window-list') {
      const state = useDesktopStore.getState();
      const result = Object.values(state.windows).map((win) => ({
        id: win.id,
        title: win.title,
        renderer: win.content.renderer,
      }));
      src.postMessage({ type: 'yaar:window-list-response', requestId, result }, '*');
      return;
    }

    // yaar:window-read
    // Normalize: agents may pass yaar://windows/{id} URIs but the store uses plain window IDs.
    const rawWindowId: string = e.data.windowId ?? '';
    const uriMatch = rawWindowId.match(/^yaar:\/\/windows\/([^/]+)/);
    const targetWindowId = uriMatch ? uriMatch[1] : rawWindowId;
    const includeImage = e.data.includeImage === true;

    if (!targetWindowId) {
      src.postMessage(
        { type: 'yaar:window-read-response', requestId, error: 'Missing windowId' },
        '*',
      );
      return;
    }

    const state = useDesktopStore.getState();
    const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
    const key = resolveWindowKey(state.windows, targetWindowId, monitorId);
    const win = state.windows[key];
    if (!win) {
      src.postMessage(
        {
          type: 'yaar:window-read-response',
          requestId,
          error: `Window "${targetWindowId}" not found`,
        },
        '*',
      );
      return;
    }

    const result: Record<string, unknown> = {
      id: win.id,
      title: win.title,
      renderer: win.content.renderer,
      content: win.content.data,
    };

    if (includeImage) {
      const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;

      if (el) {
        const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
        if (iframe?.contentWindow) {
          const imageData = await tryIframeSelfCapture(iframe);
          if (imageData) result.imageData = imageData;
        }
      }
    }

    src.postMessage({ type: 'yaar:window-read-response', requestId, result }, '*');
  });
}

/**
 * Broadcast notification state changes to all iframes via postMessage.
 * Subscribes to the notifications slice and pushes updates reactively.
 */
export function initNotificationBroadcaster() {
  let prev = useDesktopStore.getState().notifications;
  useDesktopStore.subscribe((state) => {
    if (state.notifications === prev) return;
    prev = state.notifications;
    const items = Object.values(prev);
    const iframes = document.querySelectorAll<HTMLIFrameElement>(`[${WINDOW_ID_DATA_ATTR}] iframe`);
    for (const iframe of iframes) {
      iframe.contentWindow?.postMessage(
        { type: 'yaar:notifications-update', items },
        getIframeTargetOrigin(iframe),
      );
    }
  });
}
