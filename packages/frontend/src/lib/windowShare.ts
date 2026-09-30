/**
 * The titlebar share button: share an app window with an outside agent, by URL.
 *
 * A click always copies: it shares the window if it is not shared yet (the server mints
 * the URL) and puts the URL on the clipboard. Sharing is idempotent server-side, so a click
 * on a shared window copies the *same* URL — an agent already holding it keeps working.
 * Stopping is a separate, deliberate gesture (right-click), and so is closing the window;
 * either one revokes the URL. A toggle made "copy it again" revoke it. The URL is a
 * capability — whoever holds it drives the window with its app agent's permissions
 * (`features/window/external-share.ts` on the server) — so it is never kept in the store;
 * whether the window *is* shared is store state (`WindowModel.sharedExternally`), fed by the
 * server's `WINDOW_EXTERNAL_SHARE` event rather than set here.
 */
import i18next from 'i18next';
import { useDesktopStore } from '@/store';
import { apiFetch, getRemoteConnection } from '@/lib/api';
import { copyText } from '@/lib/copyText';
import type { WindowModel } from '@/types/state';

interface ShareAnswer {
  shared: boolean;
  path?: string;
  /** The path on the server's plain loopback socket — see `routes/window-share.ts`. */
  localUrl?: string;
}

/**
 * The URL to hand an outside agent: on the remote server URL when this desktop is
 * remote, else the server's plain loopback one. Never `location.origin` — on the local
 * TLS socket that is a self-signed certificate every non-browser MCP client refuses.
 */
function shareUrl(answer: ShareAnswer): string | null {
  if (!answer.shared || !answer.path) return null;
  const remote = getRemoteConnection();
  if (remote) return `${remote.serverUrl}${answer.path}`;
  return answer.localUrl ?? `${globalThis.location.origin}${answer.path}`;
}

async function setShared(windowId: string, shared: boolean): Promise<ShareAnswer> {
  const sessionId = useDesktopStore.getState().sessionId ?? undefined;
  const res = await apiFetch('/api/window-share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionId, shared }),
  });
  const body = (await res.json().catch(() => ({}))) as ShareAnswer & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function toast(message: string, variant: 'info' | 'success' | 'error'): void {
  useDesktopStore.getState().applyAction({
    type: 'toast.show',
    id: `window-share-${Date.now()}`,
    message,
    variant,
  });
}

function failed(e: unknown): void {
  toast(
    i18next.t('window.share.failed', { error: e instanceof Error ? e.message : String(e) }),
    'error',
  );
}

/** The share button's click. Called from the handler, so the copy keeps its gesture. */
export async function shareAndCopy(win: WindowModel): Promise<void> {
  try {
    const url = shareUrl(await setShared(win.id, true));
    if (!url) throw new Error('no URL in the answer');
    if (await copyText(url)) {
      toast(i18next.t('window.share.copied'), 'success');
    } else {
      // Without the clipboard the URL has to reach the user some other way, and a toast
      // is the one place it can be read and selected.
      toast(i18next.t('window.share.copyFailed', { url }), 'info');
    }
  } catch (e) {
    failed(e);
  }
}

/** The share button's right-click: revoke the URL. A no-op for a window that is not shared. */
export async function stopSharing(win: WindowModel): Promise<void> {
  if (!win.sharedExternally) return;
  try {
    await setShared(win.id, false);
    toast(i18next.t('window.share.stopped', { title: win.title }), 'info');
  } catch (e) {
    failed(e);
  }
}
