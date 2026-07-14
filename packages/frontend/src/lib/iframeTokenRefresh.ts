/**
 * Re-mint iframe tokens when the session comes back as a different incarnation.
 *
 * Iframe tokens live only in the server process's memory (`http/iframe-tokens.ts`). A
 * server restart — `bun --watch` picking up an edit, a crash, an evicted session — takes
 * the whole token map with it, while the desktop tab lives on: its windows are still on
 * screen and the iframes inside them still present the tokens the *dead* process minted.
 * Every `/api/verb` call from those apps then answers 403 "Invalid or expired iframe
 * token" for the rest of the tab's life, which reads to the user as the app breaking
 * (devtools failing to save/compile) rather than as a lost session.
 *
 * The reconnect snapshot mints fresh tokens, but only for the windows the *server*
 * remembers. Anything the desktop opened on its own — an icon click — is not in it, and
 * a restart that found no transcript to restore has no windows in it at all.
 *
 * So on any attach that is not a rejoin of the same incarnation, ask for a new token for
 * each iframe window we are still holding. Rewriting the token rewrites the iframe's src
 * (`IframeRenderer` carries it as `__yaar_token`), which reloads the app under an
 * identity the live server recognises.
 */

import { useDesktopStore } from '@/store/desktop';
import { apiFetch } from '@/lib/api';

/**
 * The snapshot arrives on the same socket right after SESSION_ATTACHED and already carries
 * fresh tokens for the windows the server restored. Let it land first, then only touch what
 * it left stale — otherwise those iframes reload twice.
 */
const SNAPSHOT_GRACE_MS = 500;

async function mint(
  windowId: string,
  sessionId: string,
  appId?: string,
  monitorId?: string,
): Promise<string | null> {
  try {
    const res = await apiFetch('/api/iframe-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId, sessionId, appId, monitorId }),
    });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token?: string };
    return token ?? null;
  } catch {
    return null;
  }
}

/** Refresh the iframe tokens of every window that was minted against a session we lost. */
export async function refreshStaleIframeTokens(sessionId: string): Promise<void> {
  const staleTokens = new Set(
    Object.values(useDesktopStore.getState().windows)
      .map((w) => w.iframeToken)
      .filter((t): t is string => !!t),
  );
  if (staleTokens.size === 0) return;

  await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_GRACE_MS));

  const { windows, replaceIframeToken } = useDesktopStore.getState();
  const stale = Object.values(windows).filter(
    (w) => w.iframeToken && staleTokens.has(w.iframeToken),
  );

  await Promise.all(
    stale.map(async (win) => {
      const token = await mint(win.id, sessionId, win.appId, win.monitorId);
      if (token) replaceIframeToken(win.id, win.iframeToken!, token);
    }),
  );
}
