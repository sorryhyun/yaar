/**
 * Inbound iframe messages — everything an app pushes at the desktop unprompted:
 * readiness, agent interactions, app events, and text drags.
 */
import { ClientEventType } from '@/types';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { getDesktopState } from './store-access';
import { markAppWindowRegistered } from './app-protocol-relay';
import { openExternalUrl } from './open-url';

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
 * Handles: yaar:app-ready, yaar:app-interaction, yaar:app-event, yaar:drag-start.
 */
export function initIframeMessageHandlers() {
  iframeMessages.on('yaar:app-ready', (ctx) => {
    if (!ctx.source) return;
    const { windowId } = ctx.source;
    // `noReplay` crosses a postMessage boundary from app code — accept it only when it is
    // unambiguously an array of strings, and drop it silently otherwise rather than forward
    // junk the server would misinterpret as command names.
    const rawNoReplay = ctx.data.noReplay;
    const noReplay =
      Array.isArray(rawNoReplay) && rawNoReplay.every((v) => typeof v === 'string')
        ? (rawNoReplay as string[])
        : undefined;
    // Remember it: the iframe performs this handshake exactly once, but the server may
    // need to hear it more than once (see resendAppProtocolReady).
    markAppWindowRegistered(windowId, noReplay);
    console.debug(`[AppProtocol] app registered: ${windowId}`);
    // Send APP_PROTOCOL_READY immediately over WebSocket, bypassing the
    // Zustand pending queue to eliminate the subscription-drain latency.
    sendEvent(wsManager, {
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId,
      ...(noReplay ? { noReplay } : {}),
    });
  });

  iframeMessages.on('yaar:app-interaction', (ctx) => {
    if (!ctx.source) return;
    const content = ctx.data.content;
    if (typeof content !== 'string' || !content) return;
    const instructions =
      typeof ctx.data.instructions === 'string' ? ctx.data.instructions : undefined;
    getDesktopState().addPendingAppInteraction({
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
    getDesktopState().addPendingAppEvent({
      windowId: ctx.source.windowId,
      channel,
      payload: ctx.data.payload,
      // Crosses a postMessage boundary from app code, like `noReplay` above:
      // take it only as a real boolean rather than forwarding whatever arrived.
      ...(ctx.data.wakeAgent === true ? { wakeAgent: true } : {}),
    });
  });

  // A link in app content that would otherwise have navigated the app's own document
  // away (see APP_MSG.openUrl). The app frame cannot open a window itself — the
  // windows SDK is read-only — and `window.open` would leave YAAR for a browser tab,
  // so the destination lands in a window here. Which *kind* of window depends on
  // whether the site permits being framed at all; `open-url.ts` decides that.
  iframeMessages.on('yaar:open-url', (ctx) => {
    const raw = typeof ctx.data.url === 'string' ? ctx.data.url : '';
    if (!raw) return;
    const title = typeof ctx.data.title === 'string' ? ctx.data.title : '';
    // Fire-and-forget: the sender is an app frame with nothing to wait for, and the
    // window may take a round trip to place.
    void openExternalUrl(raw, title, ctx.source?.windowId);
  });

  // yaar:click — no-op (context menu removed)

  iframeMessages.on('yaar:drag-start', (ctx) => {
    if (!ctx.source) return;
    const text = String(ctx.data.text ?? '').trim();
    if (!text) return;
    _iframeDragSource = { windowId: ctx.source.windowId, text };
  });
}
