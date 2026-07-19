/**
 * Window capture — asks an iframe to draw itself, sends the result straight down the socket.
 */
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { findIframeIn, findWindowElement, getIframeTargetOrigin } from './target';

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
    // Addressed by the raw id, not a store-resolved key — see `resolveTargetKey`.
    const el = findWindowElement(windowId);
    if (!el) {
      sendFeedback(false, { error: 'Window element not found in DOM' });
      return;
    }

    const iframe = findIframeIn(el);
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
