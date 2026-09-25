/**
 * Window capture — asks an iframe to draw itself, sends the result straight down the socket.
 */
import { APP_MSG } from '@yaar/shared';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from '@/lib/transport/transport-manager';
import {
  explainMissingWindow,
  findIframeIn,
  findWindowElement,
  getIframeTargetOrigin,
} from './target';

/**
 * Outcome of a self-capture attempt. A failure always names its cause, so the
 * agent that asked can tell "the canvas is tainted, retrying is futile" from
 * "the page had not painted yet, retry".
 *
 * A *success* can carry `degraded`: the image arrived, but the capture knows it
 * left something out (a canvas it could not read, an image it could not inline,
 * or a composite that failed and was rescued by the largest-canvas fallback —
 * which returns one canvas, not the window). Without it a partial picture is
 * indistinguishable from a complete one, and the caller believes the wrong thing.
 */
export type IframeCaptureResult =
  | { imageData: string; reason?: undefined; degraded?: string[] }
  | { imageData: null; reason: string; degraded?: undefined };

/**
 * Try capturing iframe content via the postMessage self-capture protocol.
 *
 * Null responses are terminal *only when they carry a `reason`*. That condition is
 * load-bearing, not defensive: a stale capture handler compiled into an app's HTML
 * can answer a bare null while the newer frontend-injected handler is still working
 * on real pixels, and treating the first null as the answer would throw away the
 * image that was about to arrive. New-protocol handlers always attach a reason, so
 * a bare null identifies exactly the old handler — keep ignoring those and let the
 * timeout speak instead.
 */
export function tryIframeSelfCapture(
  iframe: HTMLIFrameElement,
  timeoutMs = 2000,
): Promise<IframeCaptureResult> {
  return new Promise((resolve) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ imageData: null, reason: 'no-response' });
    }, timeoutMs);

    function handler(e: MessageEvent) {
      if (
        e.data?.type === APP_MSG.captureResponse &&
        e.data.requestId === requestId &&
        e.source === iframe.contentWindow
      ) {
        if (!e.data.imageData) {
          // Legacy bare null (no reason): keep waiting — see the note above.
          if (typeof e.data.reason !== 'string' || !e.data.reason) return;
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          resolve({ imageData: null, reason: e.data.reason });
          return;
        }
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        const degraded = Array.isArray(e.data.degraded)
          ? (e.data.degraded as unknown[]).filter((n): n is string => typeof n === 'string')
          : undefined;
        resolve({
          imageData: e.data.imageData,
          ...(degraded && degraded.length > 0 ? { degraded } : {}),
        });
      }
    }

    window.addEventListener('message', handler);
    iframe.contentWindow?.postMessage(
      { type: APP_MSG.captureRequest, requestId },
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
  const sendFeedback = (
    success: boolean,
    extra?: {
      imageData?: string;
      error?: string;
      captureFailure?: string;
      captureDegraded?: string[];
    },
  ) => {
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
      // Named, because this tab not having the window says nothing about whether another
      // tab does: the capture goes to every desktop in the session, and the server waits
      // for a better answer before it lets this one stand (see handleRenderingFeedback).
      sendFeedback(false, {
        error: `Window element not found in DOM. ${explainMissingWindow(windowId)}`,
        captureFailure: 'not-mounted',
      });
      return;
    }

    const iframe = findIframeIn(el);
    if (!iframe?.contentWindow) {
      sendFeedback(false, { error: 'No iframe found in window', captureFailure: 'no-iframe' });
      return;
    }

    const result = await tryIframeSelfCapture(iframe);
    if (result.imageData) {
      const base64 = result.imageData.replace(/^data:image\/[^;]+;base64,/, '');
      sendFeedback(true, {
        imageData: base64,
        ...(result.degraded ? { captureDegraded: result.degraded } : {}),
      });
    } else {
      sendFeedback(false, {
        error: `Capture returned empty (${result.reason})`,
        captureFailure: result.reason,
      });
    }
  } catch (error) {
    sendFeedback(false, {
      error: error instanceof Error ? error.message : 'Capture failed',
      captureFailure: 'exception',
    });
  }
}
