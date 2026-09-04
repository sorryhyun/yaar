/**
 * Name resolution for the bypass proxy, and the guard that keeps it from becoming an
 * SSRF hop.
 *
 * Resolution is DoH first because a censor that resets on SNI usually poisons DNS on the
 * same path — asking the system resolver would hand back the block page's address and no
 * amount of fragmentation would help.
 *
 * DoH first, not DoH only. The proxy is on by default now, so every outbound connection
 * this server makes is resolved here; a DoH endpoint that is unreachable (captive portal,
 * a network that blocks 1.1.1.1, plain offline) would otherwise take *all* of them down,
 * and a name with only an AAAA record would never resolve at all. So a DoH failure falls
 * back to the system resolver rather than failing the dial. That fallback cannot be worse
 * than not having the proxy: if the system answer is poisoned the connection resets and
 * the caller sees the failure it would have seen anyway — whereas refusing to answer
 * turns a working direct path into a 502.
 *
 * That independence is exactly why the guard has to live here. `lib/ssrf.ts`'s
 * `validateUrl` inspects the hostname a *caller* passed; once traffic is tunnelled, the
 * address actually dialed is the one this module resolved, and nothing upstream has
 * seen it. Re-checking here is what stops `CONNECT internal.corp:443` — or a public
 * name resolving to 10.x — from reaching a network the SSRF rules exclude.
 */

import { lookup } from 'node:dns/promises';

import { isLoopback, isPrivateHostname } from '../ssrf.js';

/** Cloudflare rather than Google: fewer places censor it outright. */
export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';

/** DNS `A` record. */
const TYPE_A = 1;

/**
 * Internal IPv6 space, which `lib/ssrf.ts` does not enumerate because until the system
 * fallback existed nothing here could produce a v6 address — DoH is asked for `A` only.
 *
 *   - `fc00::/7` — unique-local, the v6 equivalent of `10.0.0.0/8`.
 *   - `::ffff:a.b.c.d` — an IPv4 address wearing a v6 hat. `refusalForAddress` unwraps
 *     these rather than pattern-matching them, so `::ffff:10.0.0.1` is refused by the
 *     same rule that refuses `10.0.0.1`.
 *   - `::`, and the v6 loopback/link-local that `isLoopback`/`isPrivateHostname` already
 *     carry (`::1`, `fe80:`), which is why they are not repeated here.
 */
const INTERNAL_V6 = [/^\[?f[cd][0-9a-f]{2}:/i, /^\[?::$/];

/** `::ffff:10.0.0.1` → `10.0.0.1`; anything else unchanged. */
function unwrapV4Mapped(address: string): string {
  const m = /^\[?::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]?$/i.exec(address);
  return m ? m[1]! : address;
}

/**
 * Why this address may not be dialed, or null if it may.
 *
 * Loopback is refused as well as private space, which is stricter than `safeFetch`,
 * where loopback is deliberately allowed. The asymmetry is intentional: this proxy is
 * an open CONNECT listener for the lifetime of the server, so anything local that finds
 * the port inherits its reach. It exists to carry traffic to censored *public* hosts,
 * and nothing it legitimately carries is on this machine.
 *
 * The v6 rules are here rather than in `lib/ssrf.ts` because this is the only caller
 * that can see a v6 address: DoH answers `A` records, so a v6 target can only arrive
 * from the system-resolver fallback below.
 */
export function refusalForAddress(address: string): string | null {
  if (!address) return 'empty address';
  const addr = unwrapV4Mapped(address);
  if (isLoopback(addr)) return `refusing loopback target ${address}`;
  if (isPrivateHostname(addr)) return `refusing internal target ${address}`;
  if (INTERNAL_V6.some((p) => p.test(addr))) return `refusing internal target ${address}`;
  return null;
}

/** An already-literal IPv4/IPv6 address needs no resolution. */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export interface Resolver {
  resolve(host: string): Promise<string>;
}

/** The system resolver, as the fallback uses it. Injected so the tests stay offline. */
export type SystemLookup = (host: string) => Promise<string>;

const systemLookup: SystemLookup = async (host) => (await lookup(host)).address;

/**
 * A DoH resolver with a system-resolver fallback and a process-lifetime cache.
 *
 * The cache is unbounded-by-TTL but bounded by `maxEntries` for the same reason the
 * host policy is: a long-running desktop session should not grow a table forever. Both
 * paths populate it — a fallback answer is still an answer, and re-asking a DoH endpoint
 * that just failed once per connection is its own way of being slow.
 */
export class DohResolver implements Resolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly dohUrl: string = DEFAULT_DOH_URL,
    private readonly maxEntries = 512,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly lookupImpl: SystemLookup = systemLookup,
  ) {}

  async resolve(host: string): Promise<string> {
    if (isIpLiteral(host)) return host;

    const cached = this.cache.get(host);
    if (cached) return cached;

    let address: string;
    try {
      address = await this.overDoh(host);
    } catch (err) {
      // Not a warning about censorship — DoH is simply unavailable or has no A record
      // for this name. Both are ordinary, and both are survivable.
      console.warn(`[FreeDPI] DoH could not resolve ${host} (${String(err)}); asking the system`);
      address = await this.lookupImpl(host);
    }

    this.remember(host, address);
    return address;
  }

  private async overDoh(host: string): Promise<string> {
    const url = `${this.dohUrl}?name=${encodeURIComponent(host)}&type=A`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) throw new Error(`DoH lookup failed for ${host}: HTTP ${res.status}`);

    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    const answer = body.Answer?.find((a) => a.type === TYPE_A)?.data;
    if (!answer) throw new Error(`no A record for ${host}`);
    return answer;
  }

  private remember(host: string, address: string): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(host, address);
  }
}
