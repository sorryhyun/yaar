/**
 * Centralized router for `yaar:*` postMessages from same-origin iframes.
 *
 * Before this router, every subsystem independently registered its own
 * `window.addEventListener('message', ...)` and duplicated iframe-source
 * resolution + coordinate conversion. This module consolidates that into
 * a single listener with a declarative route table.
 *
 * Usage:
 *   import { iframeMessages } from '@/lib/iframeMessageRouter';
 *
 *   // Persistent subscription (returns unsubscribe function)
 *   const off = iframeMessages.on('yaar:contextmenu', (ctx) => {
 *     if (!ctx.source) return;
 *     const { x, y } = ctx.source.toViewport(ctx.data.clientX, ctx.data.clientY);
 *     showContextMenu(x, y, ctx.source.windowId);
 *   });
 *
 * One-shot request/response patterns (app protocol, iframe capture) are NOT
 * handled here — they have their own lifecycle with timeouts and requestIds.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface IframeSource {
  /** The iframe element that sent the message. */
  iframe: HTMLIFrameElement;
  /** The windowId of the window containing the iframe. */
  windowId: string;
  /** Convert iframe-local coordinates to parent viewport coordinates. */
  toViewport(clientX: number, clientY: number): { x: number; y: number };
}

export interface IframeMessageContext {
  /** The raw message data (untyped — callers validate as needed). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  /**
   * Resolved iframe source, or null if the message didn't come from a
   * recognized window iframe. Handlers that need source info should
   * early-return when this is null.
   */
  source: IframeSource | null;
}

export type IframeMessageHandler = (ctx: IframeMessageContext) => void;

/**
 * Known `yaar:*` message types sent by iframe-injected scripts.
 *
 * Constrains the `on()` method so typos are caught at compile time.
 * The iframe scripts themselves are raw JS strings (template literals)
 * and can't participate in the type system — this union covers only
 * the parent-side handler registrations.
 *
 * One-shot request/response types (yaar:app-*-response, yaar:capture-response)
 * are NOT included — they use direct `window.addEventListener` with timeouts.
 */
export type YaarMessageType =
  // IFRAME_CONTEXTMENU_SCRIPT (capture-helper.ts)
  | 'yaar:click'
  | 'yaar:contextmenu'
  | 'yaar:drag-start'
  // Right-click drawing forwarded from iframes
  | 'yaar:arrow-drag-start'
  | 'yaar:arrow-drag-move'
  | 'yaar:arrow-drag-end'
  // IFRAME_APP_PROTOCOL_SCRIPT (app-protocol.ts)
  | 'yaar:app-ready'
  | 'yaar:app-interaction';

// ─── Router singleton ──────────────────────────────────────────────────

const handlers = new Map<string, Set<IframeMessageHandler>>();
let listening = false;

function resolveSource(raw: MessageEvent): IframeSource | null {
  const src = raw.source;
  if (!src) return null;

  const iframes = document.querySelectorAll<HTMLIFrameElement>('[data-window-id] iframe');
  for (const iframe of iframes) {
    if (iframe.contentWindow !== src) continue;
    const windowEl = iframe.closest<HTMLElement>('[data-window-id]');
    const windowId = windowEl?.dataset.windowId;
    if (!windowId) continue;

    return {
      iframe,
      windowId,
      toViewport(clientX: number, clientY: number) {
        const rect = iframe.getBoundingClientRect();
        return { x: rect.left + clientX, y: rect.top + clientY };
      },
    };
  }
  return null;
}

function handleMessage(e: MessageEvent) {
  const type: unknown = e.data?.type;
  if (typeof type !== 'string' || !type.startsWith('yaar:')) return;

  const set = handlers.get(type);
  if (!set?.size) return;

  const source = resolveSource(e);
  const ctx: IframeMessageContext = { data: e.data, source };

  for (const handler of set) {
    handler(ctx);
  }
}

function ensureListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', handleMessage);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Register a handler for a specific `yaar:*` message type.
 * Returns an unsubscribe function.
 */
function on(type: YaarMessageType, handler: IframeMessageHandler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  ensureListening();

  return () => {
    set.delete(handler);
  };
}

export const iframeMessages = { on } as const;
