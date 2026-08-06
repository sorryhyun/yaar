/**
 * The subscription registry's URI contract, checked rather than trusted.
 *
 * Subscriptions are keyed by literal URI string, so a key stored as
 * `yaar://apps/self/storage/` can never match the `yaar://apps/notes/storage/x.json`
 * a producer notifies with. `/api/verb/subscribe` resolves `self` before storing and
 * every producer already passes a real-id URI — but nothing said so, and the failure
 * mode is invisible: a subscription that simply never fires.
 *
 * The two boundaries answer differently on purpose, and that asymmetry is what these
 * rows pin. `subscribe` refuses (storing an unmatchable key is worse than failing the
 * request); `notifyChange`/`publishFrame` complain and carry on (a producer that got
 * that far has already done the work it is announcing — throwing would report failure
 * for a write that succeeded).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { subscriptionRegistry } from '../http/subscriptions.js';

const SELF_URI = 'yaar://apps/self/storage/';
const REAL_URI = 'yaar://apps/notes/storage/';

/** Capture console.error so an expected complaint doesn't pollute the run. */
let complaints: string[];
let originalError: typeof console.error;

beforeEach(() => {
  complaints = [];
  originalError = console.error;
  console.error = (...args: unknown[]) => {
    complaints.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.error = originalError;
});

describe('subscribe refuses an unresolved URI', () => {
  it('throws rather than storing a key nothing can match', () => {
    expect(() => subscriptionRegistry.subscribe('tok', 'win-1', 'sess-contract', SELF_URI)).toThrow(
      /self/,
    );
    expect(complaints.join('\n')).toContain('subscribe');
    // Nothing was recorded, so a later real-id notify has nobody to wake.
    expect(subscriptionRegistry.getSubscribers(`${REAL_URI}todo.json`)).toEqual([]);
  });

  it('still accepts the resolved spelling', () => {
    const id = subscriptionRegistry.subscribe('tok', 'win-1', 'sess-contract', REAL_URI);
    expect(subscriptionRegistry.getSubscribers(`${REAL_URI}todo.json`).map((s) => s.id)).toContain(
      id,
    );
    expect(complaints).toEqual([]);
    subscriptionRegistry.unsubscribe(id);
  });
});

describe('the notify boundaries complain but do not throw', () => {
  it('logs an unresolved notifyChange instead of failing the producer', () => {
    expect(() => subscriptionRegistry.notifyChange(SELF_URI, 'sess-contract')).not.toThrow();
    expect(complaints.join('\n')).toContain('notifyChange');
    expect(complaints.join('\n')).toContain(SELF_URI);
  });

  it('logs an unresolved publishFrame instead of failing the producer', () => {
    expect(() =>
      subscriptionRegistry.publishFrame(SELF_URI, 'text', { delta: 'x' }, 'sess-contract'),
    ).not.toThrow();
    expect(complaints.join('\n')).toContain('publishFrame');
  });

  it('says nothing for the resolved spelling, and still delivers', () => {
    const id = subscriptionRegistry.subscribe('tok', 'win-1', 'sess-contract', REAL_URI);
    subscriptionRegistry.notifyChange(`${REAL_URI}todo.json`, 'sess-contract');
    expect(complaints).toEqual([]);
    subscriptionRegistry.unsubscribe(id);
  });
});
