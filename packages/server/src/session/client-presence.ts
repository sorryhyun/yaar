/**
 * What each connected desktop last said about its ability to answer, and the sentence a
 * timed-out wait uses to say which silence it hit.
 *
 * The problem this exists for: an open socket is not a live desktop. A browser tab that
 * goes to the background stops running script while its WebSocket stays up — and stays up
 * past the transport's own idle timeout, because the idle clock is reset by the server's
 * own sends. Measured against a real Chrome frozen with `Page.setWebLifecycleState`, the
 * socket survived 264s of a page that could not execute a line, with the server reporting
 * the client as connected throughout. Every server→client wait in that window expired at
 * its deadline and said the only thing the server could observe — "the app did not
 * answer" — so a backgrounded phone read as an app that had broken, across every window at
 * once, which is exactly the shape of the bug this module was written for.
 *
 * Nothing here changes what a wait *does*. A deadline still fires at its deadline; a
 * timeout is still a timeout. All this adds is the reason, so the agent on the other end
 * stops being told that a working app is broken.
 *
 * Presence is tracked per connection and read per session, because an action goes to every
 * connection in the session: two tabs open and one of them visible means the desktop could
 * have answered, and no note is owed. Only tabs that report are tracked — an older client
 * that never sends the frame is simply absent — and since the note is built *only after a
 * wait has already timed out*, a session whose every known tab was away is a session where
 * saying so is true.
 */

import type { ClientPresenceState } from '@yaar/shared';
import type { ConnectionId } from './broadcast-center.js';
import type { SessionId } from './types.js';

interface ConnectionPresence {
  state: ClientPresenceState;
  /** When this connection last became unable to answer; null while it can. */
  awaySince: number | null;
  /** When it last became able to answer again; null if it has never been away. */
  returnedAt: number | null;
  /** The last state it was away in, kept after it returns so the note can name it. */
  lastAwayState: ClientPresenceState | null;
}

const sessions = new Map<SessionId, Map<ConnectionId, ConnectionPresence>>();

/** Connections that are the server's companion desktop, per session. */
const companions = new Map<SessionId, Set<ConnectionId>>();

/** Record that a connection is the companion desktop — said once, at connect. */
export function noteCompanionConnection(sessionId: SessionId, connectionId: ConnectionId): void {
  let set = companions.get(sessionId);
  if (!set) {
    set = new Set();
    companions.set(sessionId, set);
  }
  set.add(connectionId);
}

/**
 * Whether a connection is the companion desktop: always visible, and never the screen a
 * person is watching, so it is the fallback responder rather than the first pick.
 */
export function isCompanionConnection(sessionId: SessionId, connectionId: ConnectionId): boolean {
  return companions.get(sessionId)?.has(connectionId) ?? false;
}

/**
 * How long a connection has been able to answer since it last came back: `Infinity` if it
 * has never been away — or never reported, silence counting as able, as it does for
 * `connectionPresence`'s callers — and `undefined` while it is away.
 */
export function visibleFor(
  sessionId: SessionId,
  connectionId: ConnectionId,
  now: number = Date.now(),
): number | undefined {
  const presence = sessions.get(sessionId)?.get(connectionId);
  if (!presence) return Infinity;
  if (presence.state !== 'visible') return undefined;
  return presence.returnedAt === null ? Infinity : now - presence.returnedAt;
}

/** Record what a connection just said about itself. */
export function noteClientPresence(
  sessionId: SessionId,
  connectionId: ConnectionId,
  state: ClientPresenceState,
  now: number = Date.now(),
): void {
  let byConnection = sessions.get(sessionId);
  if (!byConnection) {
    byConnection = new Map();
    sessions.set(sessionId, byConnection);
  }
  const previous = byConnection.get(connectionId);
  const wasAway = previous ? previous.state !== 'visible' : false;
  const isAway = state !== 'visible';

  byConnection.set(connectionId, {
    state,
    // A tab that reports `hidden` and then `frozen` is still away since the *first* of
    // them — re-stamping here would shorten every span to its last transition.
    awaySince: isAway ? (wasAway ? (previous?.awaySince ?? now) : now) : null,
    returnedAt: !isAway && wasAway ? now : (previous?.returnedAt ?? null),
    lastAwayState: isAway ? state : (previous?.lastAwayState ?? null),
  });
}

/**
 * What one connection last said about itself, or `undefined` if it never said — an older
 * client, or one that has not reported yet. Callers ranking connections treat that as
 * "could answer": silence is not evidence of being away.
 */
export function connectionPresence(
  sessionId: SessionId,
  connectionId: ConnectionId,
): ClientPresenceState | undefined {
  return sessions.get(sessionId)?.get(connectionId)?.state;
}

/** Drop a connection's presence when its socket closes. */
/**
 * Whether a connection has ever reported being away. A tab that backgrounds once (a phone)
 * will do it again; one that never has (the always-visible companion) is the steadier pick
 * when a window needs one responder to stay with.
 */
export function hasBeenAway(sessionId: SessionId, connectionId: ConnectionId): boolean {
  return (sessions.get(sessionId)?.get(connectionId)?.lastAwayState ?? null) !== null;
}

export function forgetConnectionPresence(sessionId: SessionId, connectionId: ConnectionId): void {
  const companionSet = companions.get(sessionId);
  companionSet?.delete(connectionId);
  if (companionSet?.size === 0) companions.delete(sessionId);
  const byConnection = sessions.get(sessionId);
  if (!byConnection) return;
  byConnection.delete(connectionId);
  if (byConnection.size === 0) sessions.delete(sessionId);
}

/** Drop a whole session's presence when the session goes away. */
export function forgetSessionPresence(sessionId: SessionId): void {
  sessions.delete(sessionId);
  companions.delete(sessionId);
}

/** Tests only — the registry is process-wide. */
export function resetClientPresenceForTest(): void {
  sessions.clear();
  companions.clear();
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * The clause to append to a wait that ended in silence, or null when the desktop was
 * there the whole time and the silence is the app's own.
 *
 * `waitStartedAt` bounds the question: a tab that was backgrounded an hour ago and came
 * back before this wait even began explains nothing about it.
 */
export function clientAwayNote(
  sessionId: SessionId | undefined,
  waitStartedAt: number,
  now: number = Date.now(),
): string | null {
  if (!sessionId) return null;
  const byConnection = sessions.get(sessionId);
  if (!byConnection || byConnection.size === 0) return null;

  const all = [...byConnection.values()];
  // Any tab that could have answered for the whole wait means the silence is not this.
  const answerable = all.filter((p) => p.state === 'visible' && !returnedDuring(p, waitStartedAt));
  if (answerable.length > 0) return null;

  if (all.every((p) => p.state !== 'visible')) {
    const awaySince = Math.min(...all.map((p) => p.awaySince ?? now));
    const state = all[0]?.lastAwayState ?? 'hidden';
    const word = state === 'frozen' ? 'frozen by the browser' : 'in the background';
    return (
      `The desktop was ${word} for this entire wait (reported ${seconds(now - awaySince)} ago ` +
      'and has not come back), so nothing was running that could answer. This is the browser ' +
      'tab being backgrounded — on a phone, the user switching apps — not the app failing. ' +
      'Retrying will time out the same way until the tab is in front again; raising timeoutMs ' +
      'will not help.'
    );
  }

  // Every tab either is away, or was away and came back mid-wait.
  const returned = all.map((p) => p.returnedAt).filter((t): t is number => t !== null);
  const latest = returned.length > 0 ? Math.max(...returned) : now;
  return (
    `The desktop was backgrounded for part of this wait and came back ${seconds(now - latest)} ` +
    'ago, so the silence is likely the tab rather than the app. Retrying now should reach it.'
  );
}

/** Did this connection come back *after* the wait started — i.e. was it away for part of it? */
function returnedDuring(p: ConnectionPresence, waitStartedAt: number): boolean {
  return p.returnedAt !== null && p.returnedAt > waitStartedAt;
}
