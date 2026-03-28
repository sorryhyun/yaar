/**
 * Iframe Bridge - all communication between the desktop store and iframe windows.
 *
 * Covers: window capture, App Protocol relay, verb subscription forwarding,
 * iframe message routing, windows SDK handler, and notification broadcasting.
 */
import type { AppProtocolPostMessage, AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { ClientEventType } from '@/types';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { getRawWindowId, resolveWindowKey } from './helpers';
// Circular import — safe because useDesktopStore is only accessed at runtime (live ESM binding)
import { useDesktopStore } from './desktop';

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
 * Fire-and-forget: notify an iframe app that its window is about to close.
 * Must be called BEFORE the window element is removed from the DOM.
 */
export function notifyIframeClose(windowId: string) {
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
 * Capture a window element as an image and push feedback.
 *
 * Sends a postMessage capture request to the iframe. The injected capture
 * script handles canvas, SVG, and DOM (via foreignObject) capture using
 * the browser's native CSS engine.
 */
export async function captureWindow(windowId: string, requestId: string) {
  try {
    const el = document.querySelector(
      `[${WINDOW_ID_DATA_ATTR}="${windowId}"]`,
    ) as HTMLElement | null;
    if (!el) {
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: false,
        error: `Window element not found in DOM`,
      });
      return;
    }

    const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
    if (!iframe?.contentWindow) {
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: false,
        error: 'No iframe found in window',
      });
      return;
    }

    const iframeData = await tryIframeSelfCapture(iframe);
    if (iframeData) {
      const base64 = iframeData.replace(/^data:image\/[^;]+;base64,/, '');
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: true,
        imageData: base64,
      });
    } else {
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: false,
        error: 'Capture returned empty',
      });
    }
  } catch (error) {
    useDesktopStore.getState().addRenderingFeedback({
      requestId,
      windowId,
      renderer: 'capture',
      success: false,
      error: error instanceof Error ? error.message : 'Capture failed',
    });
  }
}

/**
 * Handle an App Protocol request by forwarding it to the target iframe via postMessage,
 * then collecting the response and pushing it as pending feedback.
 */
export function handleAppProtocolRequest(
  requestId: string,
  windowId: string,
  request: AppProtocolRequest,
) {
  const state = useDesktopStore.getState();
  const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
  const key = resolveWindowKey(state.windows, windowId, monitorId);

  const el = document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;
  if (!el) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: { kind: request.kind, error: 'Window element not found' } as AppProtocolResponse,
    });
    return;
  }

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentWindow) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: { kind: request.kind, error: 'No iframe found in window' } as AppProtocolResponse,
    });
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

  // Listen for response with timeout
  const timeoutId = setTimeout(() => {
    window.removeEventListener('message', handler);
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: {
        kind: request.kind,
        error: 'Timeout waiting for app response',
      } as AppProtocolResponse,
    });
  }, 5000);

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

    useDesktopStore.getState().addPendingAppProtocolResponse({ requestId, windowId, response });
  }

  window.addEventListener('message', handler);
  iframe.contentWindow.postMessage(msg, getIframeTargetOrigin(iframe));
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
    // Send APP_PROTOCOL_READY immediately over WebSocket, bypassing the
    // Zustand pending queue to eliminate the subscription-drain latency.
    sendEvent(wsManager, {
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: getRawWindowId(ctx.source.windowId),
    });
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
    // Normalize: agents often pass yaar:// URIs (e.g. yaar://monitors/0/win-id)
    // but the store uses plain window IDs.
    const rawWindowId: string = e.data.windowId ?? '';
    const uriMatch = rawWindowId.match(/^yaar:\/\/monitor\/[^/]+\/([^/]+)/);
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
