/**
 * Name resolution for the bypass proxy, and the guard that keeps it from becoming an
 * SSRF hop.
 *
 * Resolution is DoH by default because a censor that resets on SNI usually poisons DNS
 * on the same path — asking the system resolver would hand back the block page's
 * address and no amount of fragmentation would help.
 *
 * That independence is exactly why the guard has to live here. `lib/ssrf.ts`'s
 * `validateUrl` inspects the hostname a *caller* passed; once traffic is tunnelled, the
 * address actually dialed is the one this module resolved, and nothing upstream has
 * seen it. Re-checking here is what stops `CONNECT internal.corp:443` — or a public
 * name resolving to 10.x — from reaching a network the SSRF rules exclude.
 */

import { isLoopback, isPrivateHostname } from '../ssrf.js';

/** Cloudflare rather than Google: fewer places censor it outright. */
export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';

/** DNS `A` record. */
const TYPE_A = 1;

/**
 * Why this address may not be dialed, or null if it may.
 *
 * Loopback is refused as well as private space, which is stricter than `safeFetch`,
 * where loopback is deliberately allowed. The asymmetry is intentional: this proxy is
 * an open CONNECT listener for the lifetime of the server, so anything local that finds
 * the port inherits its reach. It exists to carry traffic to censored *public* hosts,
 * and nothing it legitimately carries is on this machine.
 */
export function refusalForAddress(address: string): string | null {
  if (!address) return 'empty address';
  if (isLoopback(address)) return `refusing loopback target ${address}`;
  if (isPrivateHostname(address)) return `refusing internal target ${address}`;
  return null;
}

/** An already-literal IPv4/IPv6 address needs no resolution. */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export interface Resolver {
  resolve(host: string): Promise<string>;
}

/**
 * A DoH resolver with a process-lifetime cache.
 *
 * The cache is unbounded-by-TTL but bounded by `maxEntries` for the same reason the
 * host policy is: a long-running desktop session should not grow a table forever.
 */
export class DohResolver implements Resolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly dohUrl: string = DEFAULT_DOH_URL,
    private readonly maxEntries = 512,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(host: string): Promise<string> {
    if (isIpLiteral(host)) return host;

    const cached = this.cache.get(host);
    if (cached) return cached;

    const url = `${this.dohUrl}?name=${encodeURIComponent(host)}&type=A`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) throw new Error(`DoH lookup failed for ${host}: HTTP ${res.status}`);

    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    const answer = body.Answer?.find((a) => a.type === TYPE_A)?.data;
    if (!answer) throw new Error(`no A record for ${host}`);

    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(host, answer);
    return answer;
  }
}
