/**
 * Attach the app's iframe token to a URL that cannot carry a header.
 *
 * `<img src>` and `EventSource` have no way to set `X-Iframe-Token`, and the browser
 * routes are now behind the same permission check as everything else, so the token
 * rides as a query parameter instead — the server accepts it there for exactly this
 * reason (see resolvePrincipal in packages/server/src/http/access.ts).
 */
export function withToken(path: string): string {
  const token = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__;
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}__yaar_token=${encodeURIComponent(token)}`;
}
