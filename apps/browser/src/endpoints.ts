/**
 * Every browser-session server route this app talks to, in one place.
 *
 * The paths were built inline in three modules (screenshot in actions.ts and sse.ts,
 * events in sse.ts, screencast in live.ts), so the same cache-busted screenshot URL
 * existed twice and the token rule below had to be remembered at each site.
 */

/**
 * Attach the app's iframe token to a URL that cannot carry a header.
 *
 * `<img src>`, `EventSource` and `WebSocket` have no way to set `X-Iframe-Token`, and the
 * browser routes are behind the same permission check as everything else, so the token
 * rides as a query parameter instead — the server accepts it there for exactly this
 * reason (see resolvePrincipal in packages/server/src/http/access.ts).
 */
function withToken(path: string): string {
  const token = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__;
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}__yaar_token=${encodeURIComponent(token)}`;
}

/** Cache-busted still screenshot. `fresh` asks the server to re-capture rather than serve the last one. */
export function screenshotUrl(browserId: string, fresh = false): string {
  return withToken(`/api/browser/${browserId}/screenshot?t=${Date.now()}${fresh ? '&fresh' : ''}`);
}

/** The SSE stream of url/title/version frames for a session. */
export function eventsUrl(browserId: string): string {
  return withToken(`/api/browser/${browserId}/events`);
}

/** Absolute ws(s):// URL for the live screencast socket, with the quality preset applied. */
export function screencastUrl(browserId: string, quality: number, maxWidth: number): string {
  const params = `?quality=${quality}${maxWidth ? `&maxWidth=${maxWidth}` : ''}`;
  const path = withToken(`/api/browser/${encodeURIComponent(browserId)}/screencast${params}`);
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${path}`;
}
