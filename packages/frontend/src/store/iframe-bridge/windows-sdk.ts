/**
 * The windows SDK — request/response over postMessage, letting an iframe read the desktop's
 * window list and one window's content. Read-only by design.
 */
import { getDesktopState } from './store-access';
import { findIframeIn, findWindowElement, resolveTargetKey } from './target';
import { tryIframeSelfCapture } from './capture';

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
      const state = getDesktopState();
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

    const key = resolveTargetKey(targetWindowId);
    const win = getDesktopState().windows[key];
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
      const el = findWindowElement(key);

      if (el) {
        const iframe = findIframeIn(el);
        if (iframe?.contentWindow) {
          const imageData = await tryIframeSelfCapture(iframe);
          if (imageData) result.imageData = imageData;
        }
      }
    }

    src.postMessage({ type: 'yaar:window-read-response', requestId, result }, '*');
  });
}
