/**
 * App Protocol relay — the frontend leg between the server (WebSocket) and an app's iframe
 * (postMessage), plus the readiness handshake and close notification that bracket it.
 */
import type { AppProtocolPostMessage, AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { getDesktopState } from './store-access';
import {
  findIframeIn,
  findWindowElement,
  getIframeTargetOrigin,
  postToIframe,
  resolveTargetKey,
} from './target';

/**
 * How long past the server's own deadline the relay keeps listening for a reply.
 *
 * Only ever used to unhook a listener, never to declare a timeout — so it is generous on
 * purpose: an app whose reply is merely slow should still be heard, and the server has
 * already spoken for itself by then.
 */
const LISTENER_GRACE_MS = 5_000;

/**
 * Windows whose iframe has announced `yaar:app-ready` — i.e. registered via `defineApp()`.
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
 *
 * Maps windowId → the `noReplay` list from that registration's `yaar:app-ready` frame
 * (undefined when the app opted nothing out). The re-announce must repeat this list
 * unchanged — it is not re-derived, because a re-announce speaks for an iframe that never
 * remounted and therefore never sent a fresher one.
 */
const registeredAppWindows = new Map<string, string[] | undefined>();

/**
 * Record that an iframe completed the `yaar:app-ready` handshake.
 *
 * Called from the iframe message handlers (`app-events.ts`), which own the inbound
 * postMessage side; the map itself lives here because `resendAppProtocolReady` is its
 * reason for existing.
 */
export function markAppWindowRegistered(windowId: string, noReplay?: string[]) {
  registeredAppWindows.set(windowId, noReplay);
}

/**
 * Re-announce App Protocol readiness for every still-mounted app iframe.
 *
 * Called on reattach (see `flushPending` in useAgentConnection). The server side is
 * idempotent — `setAppProtocol` + `notifyAppReady` — so re-announcing a window the server
 * already knows about is a no-op, and re-announcing one it forgot is the whole point.
 */
export function resendAppProtocolReady() {
  for (const [windowId, noReplay] of registeredAppWindows) {
    // Only speak for iframes that are actually still on screen. A window closed while the
    // socket was down would otherwise be announced as ready to a server that has no such
    // window — harmless, but it is a claim we cannot currently witness.
    //
    // Addressed by the raw id, not a store-resolved key: these ids came from the iframes
    // themselves, already in rendered form. See `resolveTargetKey`.
    const el = findWindowElement(windowId);
    if (!el || !findIframeIn(el)) {
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
      // Carried unchanged from the original registration — the iframe never remounted, so
      // there is no fresher list to derive, and dropping it here would tell the server the
      // app opted nothing out.
      ...(noReplay ? { noReplay } : {}),
    });
  }
}

/**
 * Fire-and-forget: notify an iframe app that its window is about to close.
 * Must be called BEFORE the window element is removed from the DOM.
 */
export function notifyIframeClose(windowId: string) {
  registeredAppWindows.delete(windowId);
  // Raw id, not a store-resolved key — the caller is the store itself, mid-close. See
  // `resolveTargetKey`.
  const el = findWindowElement(windowId);
  const iframe = el ? findIframeIn(el) : null;
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'yaar:app-close' }, getIframeTargetOrigin(iframe));
  }
}

/**
 * Send an App Protocol reply straight down the socket.
 *
 * This is an RPC answer to a server that is already sitting on a deadline for it, so
 * buffering it in the Zustand pending queue buys nothing and can cost everything: a reply
 * that misses its deadline is a corpse, and the server can only report it as the app
 * timing out. (Same reasoning that moved `yaar:app-ready` to a direct send.) The queue
 * remains only as a fallback for a socket that is down — the server has almost certainly
 * given up by the time it comes back, but a late reply that is logged beats a dropped one.
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
    getDesktopState().addPendingAppProtocolResponse({ requestId, windowId, response });
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

  // Not `resolveTargetIframe`: "no window" and "window without an iframe" are reported to
  // the server as different errors, so the steps stay separate here.
  const el = findWindowElement(resolveTargetKey(windowId));
  if (!el) {
    sendAppProtocolResponse(requestId, windowId, {
      kind: request.kind,
      error: 'Window element not found',
    } as AppProtocolResponse);
    return;
  }

  const iframe = findIframeIn(el);
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
  } else if (request.kind === 'eval') {
    msg = { type: 'yaar:app-eval-request', requestId, expression: request.expression };
  } else if (request.kind === 'describe') {
    msg = {
      type: 'yaar:app-describe-request',
      requestId,
      target: request.target,
      key: request.key,
    };
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
    } else if (msg.type === 'yaar:app-eval-response') {
      if (msg.value === undefined && msg.error == null) {
        console.warn(`[AppProtocol] Eval response missing both value and error fields`);
      }
      response = { kind: 'eval', value: msg.value, error: msg.error };
    } else if (msg.type === 'yaar:app-describe-response') {
      // `doc: null` is a real answer here — the key exists and the app defines no
      // describe() for it — so, unlike the branches above, a null carries no warning.
      response = { kind: 'describe', doc: msg.doc ?? null, error: msg.error };
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
  postToIframe(iframe, msg);
  console.debug(`[AppProtocol] postMessage sent to iframe for ${requestId} (${msg.type})`);
}
