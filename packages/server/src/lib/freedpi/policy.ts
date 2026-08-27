/**
 * When to pay for the bypass, and when a failed attempt may be retried silently.
 *
 * The bypass is not free: fragmenting with a stall costs `stallMs` on the handshake,
 * and applying that to every connection would make ordinary browsing feel broken. So
 * the proxy learns instead of assuming — every host starts `direct`, and only a reset
 * that looks injected promotes it to `bypass`. Normal traffic keeps its latency and a
 * censored host pays the stall once, then goes straight down the working path.
 *
 * Both halves are pure so the interesting decisions are testable without a socket.
 */

import type { Outcome, Route } from './types.js';

/** Learned verdicts expire so an ISP that changes its policy is noticed. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Bound on remembered hosts. Oldest is evicted first. */
const DEFAULT_MAX_HOSTS = 512;

interface Verdict {
  route: Route;
  at: number;
}

export interface HostPolicyOptions {
  ttlMs?: number;
  maxHosts?: number;
  /** Injectable clock — the tests pin time rather than sleeping. */
  now?: () => number;
}

/**
 * The learned per-host routing table.
 *
 * Deliberately not persisted across restarts. A verdict is a claim about a network
 * path, and reading a stale one off disk at boot would apply a 3-second stall to a
 * host that may no longer need it, with nothing prompting a re-test. Re-learning
 * costs one connection.
 */
export class HostPolicy {
  private readonly verdicts = new Map<string, Verdict>();
  private readonly ttlMs: number;
  private readonly maxHosts: number;
  private readonly now: () => number;

  constructor(options: HostPolicyOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
    this.now = options.now ?? Date.now;
  }

  /** How the next connection to `host` should be dialed. Unknown hosts try direct. */
  route(host: string): Route {
    const hit = this.verdicts.get(host);
    if (!hit) return 'direct';
    if (this.now() - hit.at > this.ttlMs) {
      this.verdicts.delete(host);
      return 'direct';
    }
    return hit.route;
  }

  /**
   * Fold one finished attempt into the table.
   *
   * Only two outcomes teach anything. `served` over `direct` clears the host; a `reset`
   * marks it blocked. `served` over `bypass` deliberately does *not* clear it — that is
   * the bypass working, which is evidence the host still needs it. `inconclusive` is
   * dropped rather than guessed at, so a refused connection or a DNS failure cannot
   * strand a host on the slow path.
   */
  record(host: string, route: Route, outcome: Outcome): void {
    if (outcome === 'inconclusive') return;
    if (outcome === 'served' && route === 'bypass') {
      this.touch(host, 'bypass');
      return;
    }
    this.touch(host, outcome === 'reset' ? 'bypass' : 'direct');
  }

  /** Current verdict without the read refreshing anything. For logs and tests. */
  peek(host: string): Route | null {
    const hit = this.verdicts.get(host);
    if (!hit || this.now() - hit.at > this.ttlMs) return null;
    return hit.route;
  }

  get size(): number {
    return this.verdicts.size;
  }

  clear(): void {
    this.verdicts.clear();
  }

  /** Insert-or-refresh, keeping Map insertion order as the eviction order. */
  private touch(host: string, route: Route): void {
    this.verdicts.delete(host);
    this.verdicts.set(host, { route, at: this.now() });
    while (this.verdicts.size > this.maxHosts) {
      const oldest = this.verdicts.keys().next();
      if (oldest.done) break;
      this.verdicts.delete(oldest.value);
    }
  }
}

/** Everything `canReplay` needs to know about an attempt that just died. */
export interface ReplayState {
  /** How this attempt was dialed. */
  route: Route;
  /** How it ended. */
  outcome: Outcome;
  /** Bytes already handed to the client from upstream. */
  serverBytesDelivered: number;
  /** Attempts made for this tunnel, including the one that just failed. */
  attempts: number;
  /** Whether the first-flight payload is still buffered and can be re-sent. */
  hasFirstFlight: boolean;
}

/**
 * Whether a dead attempt can be re-dialed without the client ever knowing.
 *
 * This is what makes learning cheap enough to be worth doing. The client is mid-TLS,
 * blocked waiting for a ServerHello, and its ClientHello is deterministic — so as long
 * as it has seen *nothing* from upstream, opening a fresh connection and replaying the
 * identical first flight is invisible to it. One byte delivered and that stops being
 * true: the TLS state machine has advanced, and a second ServerHello on a new socket
 * would be protocol garbage.
 *
 * Restricted to a `reset` after a `direct` attempt. A bypass that resets is not
 * evidence a second bypass would fare better, and replaying it would just double the
 * stall the user waits through.
 */
export function canReplay(state: ReplayState): boolean {
  return (
    state.route === 'direct' &&
    state.outcome === 'reset' &&
    state.serverBytesDelivered === 0 &&
    state.attempts === 1 &&
    state.hasFirstFlight
  );
}
