/**
 * The two facts a headless "companion" desktop rests on.
 *
 * The problem: on a phone, switching away from YAAR backgrounds the tab, and a
 * backgrounded tab runs no script — so `__screenshot` and every other read that is a
 * round trip into the page stops answering. `client-presence.ts` measures that at 264s
 * of a socket that stays open past a page that cannot execute a line.
 *
 * The proposed fix adds no new mechanism: park a second, always-visible client (a
 * server-side headless Chrome) in the same session, and let *it* answer the round trips
 * the phone cannot. That only works if two things already hold, and these pin both:
 *
 *   1. A session's events reach **every** connection in it, not just the newest — so the
 *      companion sees the `window.capture` the phone slept through.
 *   2. Presence is read per *session*, so one visible connection is enough — the away
 *      note, which exists to tell an agent "the app is fine, the tab was gone", must stay
 *      silent when the companion could have answered.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerEvent } from '@yaar/shared';

import { BroadcastCenter, type ConnectionId } from '../session/broadcast-center.js';
import { WS_OPEN, type SessionId, type YaarWebSocket } from '../session/types.js';
import {
  noteClientPresence,
  clientAwayNote,
  resetClientPresenceForTest,
} from '../session/client-presence.js';

const SESSION = 'sess-companion' as SessionId;
const PHONE = 'conn-phone' as ConnectionId;
const COMPANION = 'conn-headless' as ConnectionId;

class FakeSocket implements YaarWebSocket {
  readyState = WS_OPEN;
  sent: string[] = [];
  getBufferedAmount(): number {
    return 0;
  }
  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(String(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

const captureEvent = {
  type: 'action',
  action: { type: 'window.capture' },
} as unknown as ServerEvent;

describe('a headless companion client in the same session', () => {
  beforeEach(() => resetClientPresenceForTest());

  it('receives the capture the backgrounded phone slept through', () => {
    const bc = new BroadcastCenter();
    const phone = new FakeSocket();
    const companion = new FakeSocket();
    bc.subscribe(PHONE, phone, SESSION);
    bc.subscribe(COMPANION, companion, SESSION);

    // Both, not one: a capture goes out on the session, and whichever client is awake
    // answers first. If this were 1, parking a companion would buy nothing.
    expect(bc.publishToSession(SESSION, captureEvent)).toBe(2);
    expect(companion.sent).toHaveLength(1);
  });

  it('suppresses the away note while the companion is visible', () => {
    const waitStartedAt = Date.now() - 5_000;
    noteClientPresence(SESSION, PHONE, 'frozen', waitStartedAt);
    noteClientPresence(SESSION, COMPANION, 'visible', waitStartedAt);

    // The phone is frozen, but something in this session could have answered — so a
    // timeout here is the app's own, and must not be blamed on a backgrounded tab.
    expect(clientAwayNote(SESSION, waitStartedAt)).toBeNull();
  });

  it('still reports away when the companion is gone and only the frozen phone is left', () => {
    const waitStartedAt = Date.now() - 5_000;
    noteClientPresence(SESSION, PHONE, 'frozen', waitStartedAt);

    expect(clientAwayNote(SESSION, waitStartedAt)).toContain('frozen by the browser');
  });
});
