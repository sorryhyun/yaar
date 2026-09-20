/**
 * `?sessionId=` — open this desktop *into* an existing session instead of starting one.
 *
 * Normally a desktop has no session until the server hands it one: `sessionId` starts null,
 * the socket opens without it, and `SessionHub.getOrCreate(null, …)` mints a fresh session.
 * That is right for a person opening YAAR, and wrong for the one case where a second client
 * is deliberately joining the first's session.
 *
 * The case is a phone. A backgrounded tab runs no script, so every read that is a round trip
 * into the page — `__screenshot` above all — stops answering the moment the user switches
 * apps, and `client-presence.ts` measures that at 264s of an open socket in front of a page
 * that cannot execute a line. But a session's actions go to *every* connection in it and the
 * first answer wins, and the away note stays silent while any connection is visible. So a
 * second, always-visible client parked in the same session answers what the phone cannot —
 * no new mechanism, only a way to say which session to join.
 *
 * The server has always accepted this (`websocket/server.ts` reads `sessionId` off the query
 * and `getOrCreate` returns the live session under that id); this is the missing half.
 *
 * Deliberately **not** persisted, unlike `?ui=`. A pin that outlived its URL would mean an
 * ordinary tab silently rejoining someone else's session on a later visit. The query string
 * already survives a reload, which is the only place the pin needs to reach.
 */

/**
 * The session this document was told to join, or null for the usual "give me a new one".
 *
 * A blank or whitespace-only value is treated as absent: `?sessionId=` with nothing after it
 * is a URL-building slip, and honouring it would send the server an empty id to look up.
 */
export function readJoinSessionId(search = globalThis.location?.search ?? ''): string | null {
  const raw = new URLSearchParams(search).get('sessionId');
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
