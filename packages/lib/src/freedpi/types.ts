/**
 * A local HTTP CONNECT proxy that gets TLS past SNI-matching DPI.
 *
 * The censorship this defeats is a middlebox that reads the `server_name` out of a
 * plaintext ClientHello and injects a TCP reset. The countermeasures, tried cheapest
 * first (`Route`), are all in `split.ts`: cut the hello into two TLS records so a
 * parser that reads the first one finds no name; failing that, make sure no single TCP
 * segment carries the whole hostname and, where the middlebox reassembles the stream,
 * outlast the buffer it reassembles into (`FreeDpiConfig.stallMs`).
 *
 * Everything here is *stream* fragmentation, which is the ceiling a kernel TCP socket
 * imposes. Out-of-order segments and low-TTL decoy packets — what SpoofDPI's
 * `--https-disorder` and `--https-fake-count` do — need fabricated sequence numbers,
 * so they need raw packet injection and are deliberately out of scope.
 */

/**
 * Which way one upstream connection is dialed. A ladder, cheapest first:
 *
 *   - `direct`  — plain, what every host starts on.
 *   - `tlsrec`  — the ClientHello rewritten as two TLS *records* cut inside the
 *                 hostname, each in its own segment, no stall. Beats a middlebox that
 *                 reassembles TCP but parses the SNI out of the first record only.
 *   - `bypass`  — two TCP segments with `stallMs` between them. Beats a middlebox
 *                 that reassembles everything, by outliving its buffer. Slow.
 *
 * A reset on one rung escalates to the next (`policy.escalate`).
 */
export type Route = 'direct' | 'tlsrec' | 'bypass';

/** What a finished attempt tells the policy about the host. */
export type Outcome =
  /** Server bytes came back — whatever route this was, it works. */
  | 'served'
  /** Died before any server byte, the shape an injected reset has. */
  | 'reset'
  /** Failed for a reason that says nothing about censorship (DNS, refused, timeout). */
  | 'inconclusive';

export interface FreeDpiConfig {
  /** Loopback port to listen on. 0 picks a free one. */
  port?: number;
  /**
   * Milliseconds to wait between the two halves of a fragmented ClientHello.
   *
   * A middlebox that reassembles defeats fragmentation alone; it only fails to match
   * once the second half arrives after its reassembly buffer has expired. Measured on
   * SK Broadband (AS9318) in 2026-08: 0–1000ms blocked, 2500ms intermittent, 3000ms
   * reliable over six trials. That threshold is one ISP's tuning, not a constant — it
   * is a config field precisely because it can move.
   */
  stallMs?: number;
  /** How long a learned per-host verdict is trusted before it is re-tested. */
  verdictTtlMs?: number;
  /** Upper bound on remembered hosts, so a long session cannot grow without limit. */
  maxHosts?: number;
  /** DoH endpoint. Used because a censor that resets on SNI often poisons DNS too. */
  dohUrl?: string;
}

/** A running proxy. The lifecycle only ever needs these three things. */
export interface FreeDpiProxy {
  /** Port actually bound, for `--proxy-server=` and `fetch`'s `proxy` option. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` — the form both consumers want. */
  readonly proxyUrl: string;
  /** Stop listening and drop the learned-host table. */
  stop(): void;
}
