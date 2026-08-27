/**
 * The learned routing table and the silent-replay rule.
 *
 * These two decide whether the feature is usable or merely correct. Route every host
 * through the bypass and each handshake pays `stallMs`; route none and the censored
 * host never loads. The table is the compromise, and it is only cheap because a failed
 * direct attempt can be re-dialed without the client noticing — so `canReplay`'s
 * preconditions are load-bearing rather than defensive. The one that matters most is
 * `serverBytesDelivered === 0`: replay after the client has seen a ServerHello would
 * put two server flights into one TLS state machine.
 *
 * Time is injected throughout. A test that slept for a 30-minute TTL would be a test
 * nobody runs.
 */

import { describe, it, expect } from 'bun:test';
import { HostPolicy, canReplay, type ReplayState } from '../lib/freedpi/policy.js';

/** A controllable clock, so TTL behaviour is asserted rather than waited for. */
function clock(start = 1_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe('HostPolicy routing', () => {
  it('sends an unknown host direct, so ordinary traffic pays nothing', () => {
    expect(new HostPolicy().route('example.com')).toBe('direct');
  });

  it('promotes a host to bypass after an injected reset', () => {
    const policy = new HostPolicy();
    policy.record('blocked.example', 'direct', 'reset');
    expect(policy.route('blocked.example')).toBe('bypass');
  });

  it('keeps a host on bypass while the bypass is what is working', () => {
    // `served` over `bypass` is the bypass doing its job — not evidence the block lifted.
    const policy = new HostPolicy();
    policy.record('blocked.example', 'direct', 'reset');
    policy.record('blocked.example', 'bypass', 'served');
    expect(policy.route('blocked.example')).toBe('bypass');
  });

  it('confirms a host as direct when direct serves it', () => {
    const policy = new HostPolicy();
    policy.record('fine.example', 'direct', 'served');
    expect(policy.route('fine.example')).toBe('direct');
  });

  it('learns nothing from an inconclusive failure', () => {
    // A refused port or a DNS failure must not strand a host on the slow path.
    const policy = new HostPolicy();
    policy.record('flaky.example', 'direct', 'inconclusive');
    expect(policy.peek('flaky.example')).toBeNull();
    expect(policy.size).toBe(0);
  });

  it('re-tests a host once its verdict goes stale', () => {
    const c = clock();
    const policy = new HostPolicy({ ttlMs: 1_000, now: c.now });
    policy.record('blocked.example', 'direct', 'reset');
    expect(policy.route('blocked.example')).toBe('bypass');

    c.advance(1_001);
    // The ISP may have changed its mind; the table must not be the reason we never find out.
    expect(policy.route('blocked.example')).toBe('direct');
  });

  it('reports a stale verdict as absent without a read resurrecting it', () => {
    const c = clock();
    const policy = new HostPolicy({ ttlMs: 1_000, now: c.now });
    policy.record('blocked.example', 'direct', 'reset');
    c.advance(1_001);
    expect(policy.peek('blocked.example')).toBeNull();
  });
});

describe('HostPolicy bounds', () => {
  it('evicts oldest first and never exceeds its cap', () => {
    const policy = new HostPolicy({ maxHosts: 3 });
    for (const h of ['a', 'b', 'c', 'd']) policy.record(h, 'direct', 'reset');

    expect(policy.size).toBe(3);
    expect(policy.peek('a')).toBeNull();
    expect(policy.peek('d')).toBe('bypass');
  });

  it('refreshes position on re-record, so an active host is not evicted', () => {
    const policy = new HostPolicy({ maxHosts: 2 });
    policy.record('a', 'direct', 'reset');
    policy.record('b', 'direct', 'reset');
    policy.record('a', 'direct', 'reset'); // `a` is live again
    policy.record('c', 'direct', 'reset'); // evicts `b`, the genuinely oldest

    expect(policy.peek('a')).toBe('bypass');
    expect(policy.peek('b')).toBeNull();
    expect(policy.peek('c')).toBe('bypass');
  });
});

describe('canReplay', () => {
  const base: ReplayState = {
    route: 'direct',
    outcome: 'reset',
    serverBytesDelivered: 0,
    attempts: 1,
    hasFirstFlight: true,
  };

  it('replays a direct attempt reset before any server byte', () => {
    expect(canReplay(base)).toBe(true);
  });

  it('refuses once the client has seen upstream bytes', () => {
    // The TLS state machine has advanced; a second ServerHello would be garbage to it.
    expect(canReplay({ ...base, serverBytesDelivered: 1 })).toBe(false);
  });

  it('refuses to retry a bypass attempt', () => {
    // A bypass that reset is no evidence a second bypass fares better — it just
    // doubles the stall the user sits through.
    expect(canReplay({ ...base, route: 'bypass' })).toBe(false);
  });

  it('replays at most once', () => {
    expect(canReplay({ ...base, attempts: 2 })).toBe(false);
  });

  it('refuses when the first flight is no longer buffered', () => {
    expect(canReplay({ ...base, hasFirstFlight: false })).toBe(false);
  });

  it('refuses for failures that are not reset-shaped', () => {
    expect(canReplay({ ...base, outcome: 'inconclusive' })).toBe(false);
    expect(canReplay({ ...base, outcome: 'served' })).toBe(false);
  });
});
