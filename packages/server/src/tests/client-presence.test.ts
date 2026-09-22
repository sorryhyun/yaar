/**
 * The presence registry, and the one question it exists to answer: when a wait ended in
 * silence, was there anything on the other end that could have broken it?
 *
 * The interesting cases are all about *not* answering yes too readily. A note that shows
 * up on timeouts it cannot explain is worse than no note, because it excuses the broken
 * app it was appended to — so most of what is asserted here is silence.
 *
 * Every case pins `now` and the timestamps explicitly rather than sleeping: the whole
 * module is arithmetic over instants, and a test that waits for real time to pass is
 * asserting the clock.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  noteClientPresence,
  clientAwayNote,
  forgetConnectionPresence,
  forgetSessionPresence,
  resetClientPresenceForTest,
  isUserWatching,
  noteCompanionConnection,
  onPresenceChange,
} from '../session/client-presence.js';

const SESSION = 'ses-test';
const TAB = 'conn-1';
const OTHER_TAB = 'conn-2';

/** A readable timeline: t(0) is "the start", and every case says how far along it is. */
const T0 = 1_000_000;
const t = (seconds: number) => T0 + seconds * 1000;

beforeEach(() => resetClientPresenceForTest());

describe('clientAwayNote — when there is nothing to say', () => {
  it('says nothing about a session it has never heard of', () => {
    expect(clientAwayNote('ses-unknown', t(0), t(10))).toBeNull();
  });

  it('says nothing when no session id is in hand', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    expect(clientAwayNote(undefined, t(0), t(10))).toBeNull();
  });

  it('says nothing about a desktop that was visible throughout', () => {
    noteClientPresence(SESSION, TAB, 'visible', t(0));
    expect(clientAwayNote(SESSION, t(5), t(10))).toBeNull();
  });

  it('says nothing when the tab was away, but came back before the wait began', () => {
    // The backgrounding is real and is *not* an explanation for this wait — the tab had
    // been back for five seconds before anyone asked it anything.
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    noteClientPresence(SESSION, TAB, 'visible', t(5));
    expect(clientAwayNote(SESSION, t(10), t(20))).toBeNull();
  });

  it('says nothing while another tab was there to answer', () => {
    // An action reaches every connection in the session, so one live tab is enough for
    // the silence to be the app's own.
    noteClientPresence(SESSION, TAB, 'frozen', t(0));
    noteClientPresence(SESSION, OTHER_TAB, 'visible', t(0));
    expect(clientAwayNote(SESSION, t(5), t(10))).toBeNull();
  });
});

describe('clientAwayNote — when the desktop was away', () => {
  it('names the background, withdraws the retry advice, and reports how long', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    const note = clientAwayNote(SESSION, t(5), t(30));

    expect(note).not.toBeNull();
    expect(note!).toContain('background');
    expect(note!).toContain('not the app failing');
    expect(note!).toContain('will not help');
    // Measured from when it went away, not from when the wait started.
    expect(note!).toContain('30s ago');
  });

  it('distinguishes a tab the browser actually froze', () => {
    noteClientPresence(SESSION, TAB, 'frozen', t(0));
    expect(clientAwayNote(SESSION, t(0), t(10))!).toContain('frozen by the browser');
  });

  it('dates a hidden-then-frozen tab from when it first went away', () => {
    // A tab reports `hidden` on its way out and `frozen` when the browser stops it. Those
    // are one absence, not two — re-stamping on the second would report a 2s outage for a
    // tab that had been gone for half a minute.
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    noteClientPresence(SESSION, TAB, 'frozen', t(28));
    expect(clientAwayNote(SESSION, t(0), t(30))!).toContain('30s ago');
  });

  it('speaks only when every known tab was away', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    noteClientPresence(SESSION, OTHER_TAB, 'hidden', t(0));
    expect(clientAwayNote(SESSION, t(5), t(10))).not.toBeNull();
  });
});

describe('clientAwayNote — a tab that came back mid-wait', () => {
  it('reports a partial absence, and says a retry should now work', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    noteClientPresence(SESSION, TAB, 'visible', t(8));

    // The wait started at t(2) — while the tab was away — and ended at t(10).
    const note = clientAwayNote(SESSION, t(2), t(10));
    expect(note).not.toBeNull();
    expect(note!).toContain('part of this wait');
    expect(note!).toContain('should reach it');
    // Deliberately *not* the standing "retrying will not help": it will.
    expect(note!).not.toContain('will not help');
  });
});

describe('forgetting', () => {
  it('drops one connection and keeps the rest of the session', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    noteClientPresence(SESSION, OTHER_TAB, 'hidden', t(0));
    forgetConnectionPresence(SESSION, TAB);

    // The surviving tab still accounts for the session.
    expect(clientAwayNote(SESSION, t(0), t(10))).not.toBeNull();

    forgetConnectionPresence(SESSION, OTHER_TAB);
    // Nothing left that reported: back to knowing nothing, not to claiming absence.
    expect(clientAwayNote(SESSION, t(0), t(10))).toBeNull();
  });

  it('drops a whole session', () => {
    noteClientPresence(SESSION, TAB, 'frozen', t(0));
    forgetSessionPresence(SESSION);
    expect(clientAwayNote(SESSION, t(0), t(10))).toBeNull();
  });

  it('does not resurrect a stale absence when a connection id is reused', () => {
    noteClientPresence(SESSION, TAB, 'hidden', t(0));
    forgetConnectionPresence(SESSION, TAB);
    // A reconnecting tab announces itself; that announcement is the whole record.
    noteClientPresence(SESSION, TAB, 'visible', t(20));
    expect(clientAwayNote(SESSION, t(20), t(30))).toBeNull();
  });
});

describe('isUserWatching', () => {
  it('is false with no connection at all — a killed tab has nobody left to report', () => {
    expect(isUserWatching(SESSION)).toBe(false);
  });

  it('follows the user’s tab, and never counts the companion', () => {
    noteCompanionConnection(SESSION, OTHER_TAB);
    noteClientPresence(SESSION, OTHER_TAB, 'visible', t(0));
    expect(isUserWatching(SESSION)).toBe(false);

    noteClientPresence(SESSION, TAB, 'visible', t(0));
    expect(isUserWatching(SESSION)).toBe(true);

    noteClientPresence(SESSION, TAB, 'hidden', t(1));
    expect(isUserWatching(SESSION)).toBe(false);
  });

  it('tells presence listeners about reports and disconnects', () => {
    const heard: string[] = [];
    const off = onPresenceChange((sid) => heard.push(sid));
    noteClientPresence(SESSION, TAB, 'visible', t(0));
    forgetConnectionPresence(SESSION, TAB);
    off();
    noteClientPresence(SESSION, TAB, 'visible', t(1));
    expect(heard).toEqual([SESSION, SESSION]);
  });
});
