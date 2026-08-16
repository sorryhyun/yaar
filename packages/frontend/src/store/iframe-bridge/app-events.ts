/**
 * Inbound iframe messages — everything an app pushes at the desktop unprompted:
 * readiness, agent interactions, app events, and text drags.
 */
import { cascadeWindowBounds, WINDOW_PLACEMENT } from '@yaar/shared';
import { ClientEventType } from '@/types';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';
import { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from '@/constants/layout';
import { getDesktopState, getDesktopStore } from './store-access';
import { markAppWindowRegistered } from './app-protocol-relay';

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
  // so the destination lands in a window here.
  iframeMessages.on('yaar:open-url', (ctx) => {
    const raw = typeof ctx.data.url === 'string' ? ctx.data.url : '';
    if (!raw) return;
    // Absolute first: the guard already resolved the href against the app's own
    // base, so a relative value here is some other sender's, and resolving it
    // against the desktop is a guess we only make when there is nothing better.
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      try {
        parsed = new URL(raw, window.location.href);
      } catch {
        return;
      }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    const store = getDesktopState();
    const monitorId = store.activeMonitorId;
    const linkText = typeof ctx.data.title === 'string' ? ctx.data.title.trim() : '';
    const title = linkText || parsed.hostname || parsed.href;
    const windowId = `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const content = { renderer: 'iframe' as const, data: parsed.href };
    const openOnMonitor = Object.values(store.windows).filter(
      (win) => win.monitorId === monitorId,
    ).length;
    const bounds = cascadeWindowBounds(
      openOnMonitor,
      WINDOW_PLACEMENT.defaultWidth,
      WINDOW_PLACEMENT.defaultHeight,
      {
        w: globalThis.innerWidth || DEFAULT_VIEWPORT_WIDTH,
        h: globalThis.innerHeight || DEFAULT_VIEWPORT_HEIGHT,
      },
    );

    store.applyActions([{ type: 'window.create', windowId, title, bounds, content }]);
    // The agent has to hear about a window it did not open, or the next thing it reads
    // of the desktop contains a window it cannot account for.
    getDesktopStore().setState((s) => ({
      pendingInteractions: [
        ...s.pendingInteractions,
        {
          type: 'window.create' as const,
          timestamp: Date.now(),
          windowId,
          windowTitle: title,
          monitorId,
          bounds,
          content,
          details: ctx.source
            ? `opened by a link in window ${ctx.source.windowId}`
            : 'opened by a link in an app',
        },
      ],
    }));
  });

  // yaar:click — no-op (context menu removed)

  iframeMessages.on('yaar:drag-start', (ctx) => {
    if (!ctx.source) return;
    const text = String(ctx.data.text ?? '').trim();
    if (!text) return;
    _iframeDragSource = { windowId: ctx.source.windowId, text };
  });
}
