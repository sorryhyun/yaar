/**
 * Where to cut a ClientHello so no segment carries a matchable hostname.
 *
 * Pure on purpose: this is the half of the bypass that has a right answer, and it is
 * testable without a socket. `proxy.ts` owns the writing, which is where the flushing
 * and the stall live.
 */

/** TLS record type for `handshake`. */
const TLS_HANDSHAKE = 0x16;
/** Handshake message type for `client_hello`, at record offset 5. */
const CLIENT_HELLO = 0x01;

/** Fallback cut when the hostname is not found in the payload. */
const FALLBACK_CUT = 1;

export interface SplitPlan {
  /**
   * Ascending byte offsets to cut at. Empty means send the payload in one write.
   *
   * Offsets rather than slices so the caller keeps one buffer and the plan stays
   * comparable in tests.
   */
  cuts: number[];
  /** Which rule produced the cut, for logs and for the tests to pin. */
  strategy: 'sni' | 'fallback' | 'none';
}

/** Whether a payload is a TLS ClientHello, i.e. the thing worth fragmenting. */
export function isClientHello(payload: Uint8Array): boolean {
  return payload.length > 5 && payload[0] === TLS_HANDSHAKE && payload[5] === CLIENT_HELLO;
}

/**
 * Locate the SNI hostname inside a ClientHello.
 *
 * A literal byte search rather than a TLS extension walk. The hostname is plaintext and
 * appears once, so the search finds it without the parser being one more thing that can
 * be wrong about a malformed record — and a *wrong* offset here is harmless, because
 * every offset still produces a valid fragmentation, just a less useful one.
 *
 * Returns -1 when absent, which is the honest answer for an ECH'd or session-resumed
 * hello that carries no cleartext name.
 */
export function findHostname(payload: Uint8Array, host: string): number {
  if (!host) return -1;
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).indexOf(
    host,
    0,
    'utf8',
  );
}

/**
 * Plan the fragmentation for one first-flight payload.
 *
 * Cutting *inside* the hostname is the point: a middlebox that does not reassemble sees
 * two segments, neither containing `pornhub.com`, and has nothing to match on. Cutting
 * before or after the name would leave it intact in one segment.
 */
export function planSplit(payload: Uint8Array, host: string): SplitPlan {
  if (!isClientHello(payload) || payload.length < 4) return { cuts: [], strategy: 'none' };

  const at = findHostname(payload, host);
  if (at > 0 && host.length >= 2) {
    const mid = at + Math.floor(host.length / 2);
    // Guard the ends: a cut at 0 or at length is not a cut, it is one write.
    if (mid > 0 && mid < payload.length) return { cuts: [mid], strategy: 'sni' };
  }

  const fallback = Math.min(FALLBACK_CUT, payload.length - 1);
  return fallback > 0 ? { cuts: [fallback], strategy: 'fallback' } : { cuts: [], strategy: 'none' };
}

/** Apply a plan, yielding the segments to write in order. */
export function segmentsFor(payload: Uint8Array, plan: SplitPlan): Uint8Array[] {
  if (plan.cuts.length === 0) return [payload];
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const cut of plan.cuts) {
    out.push(payload.subarray(prev, cut));
    prev = cut;
  }
  out.push(payload.subarray(prev));
  return out.filter((s) => s.length > 0);
}
