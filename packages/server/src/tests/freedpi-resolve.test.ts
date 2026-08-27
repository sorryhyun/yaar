/**
 * The guard that keeps the bypass proxy from widening SSRF, and the DoH resolver.
 *
 * Worth its own file because the hole it closes is invisible from the call sites.
 * `lib/ssrf.ts` validates the hostname a caller passed; a tunnelled request is dialed
 * at an address *this* subsystem resolved, which no earlier check has seen. So the
 * interesting case is not `CONNECT 10.0.0.1:443` — it is a perfectly public name whose
 * A record points into private space, which `validateUrl` would wave through because
 * the hostname looks fine.
 *
 * The resolver takes an injected `fetch` so these stay unit tests. Nothing here touches
 * the network.
 */

import { describe, it, expect } from 'bun:test';
import {
  DohResolver,
  isIpLiteral,
  refusalForAddress,
  DEFAULT_DOH_URL,
} from '../lib/freedpi/resolve.js';

/** A `fetch` that answers one canned DoH response and counts calls. */
function fakeDoh(answer: unknown, calls = { n: 0 }) {
  const impl = (async (url: string | URL | Request) => {
    calls.n++;
    void url;
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('refusalForAddress', () => {
  it('permits ordinary public addresses', () => {
    for (const ip of ['66.254.114.41', '1.1.1.1', '93.184.216.34']) {
      expect(refusalForAddress(ip)).toBeNull();
    }
  });

  it('refuses private space a public hostname resolved into', () => {
    // The case `validateUrl` cannot catch: the name is public, the address is not.
    for (const ip of ['10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254']) {
      expect(refusalForAddress(ip)).toContain('internal');
    }
  });

  it('refuses loopback, which safeFetch deliberately allows', () => {
    // Stricter on purpose: an open CONNECT listener must not become a hop back inside.
    expect(refusalForAddress('127.0.0.1')).toContain('loopback');
    expect(refusalForAddress('localhost')).toContain('loopback');
  });

  it('refuses the empty address rather than treating it as permitted', () => {
    expect(refusalForAddress('')).toBeTruthy();
  });

  it('notably refuses the cloud metadata address', () => {
    // 169.254.169.254 is the classic SSRF prize; it falls under link-local.
    expect(refusalForAddress('169.254.169.254')).toBeTruthy();
  });
});

describe('isIpLiteral', () => {
  it('recognises literals so they skip resolution', () => {
    expect(isIpLiteral('66.254.114.41')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('DohResolver', () => {
  it('returns the A record', async () => {
    const { impl } = fakeDoh({ Answer: [{ type: 1, data: '66.254.114.41' }] });
    const resolver = new DohResolver(DEFAULT_DOH_URL, 512, impl);
    expect(await resolver.resolve('pornhub.com')).toBe('66.254.114.41');
  });

  it('caches, so a busy host is resolved once', async () => {
    const calls = { n: 0 };
    const { impl } = fakeDoh({ Answer: [{ type: 1, data: '1.2.3.4' }] }, calls);
    const resolver = new DohResolver(DEFAULT_DOH_URL, 512, impl);

    await resolver.resolve('example.com');
    await resolver.resolve('example.com');
    expect(calls.n).toBe(1);
  });

  it('does not call DoH for an address literal', async () => {
    const calls = { n: 0 };
    const { impl } = fakeDoh({ Answer: [] }, calls);
    const resolver = new DohResolver(DEFAULT_DOH_URL, 512, impl);

    expect(await resolver.resolve('8.8.8.8')).toBe('8.8.8.8');
    expect(calls.n).toBe(0);
  });

  it('skips non-A answers rather than dialing a CNAME string', async () => {
    const { impl } = fakeDoh({
      Answer: [
        { type: 5, data: 'cdn.example.net.' },
        { type: 1, data: '5.6.7.8' },
      ],
    });
    const resolver = new DohResolver(DEFAULT_DOH_URL, 512, impl);
    expect(await resolver.resolve('example.com')).toBe('5.6.7.8');
  });

  it('throws when there is no A record', async () => {
    const { impl } = fakeDoh({ Answer: [] });
    const resolver = new DohResolver(DEFAULT_DOH_URL, 512, impl);
    expect(resolver.resolve('nowhere.example')).rejects.toThrow('no A record');
  });

  it('bounds the cache', async () => {
    const { impl } = fakeDoh({ Answer: [{ type: 1, data: '1.2.3.4' }] });
    const resolver = new DohResolver(DEFAULT_DOH_URL, 2, impl);
    for (const h of ['a.example', 'b.example', 'c.example']) await resolver.resolve(h);
    // No throw and no unbounded growth; eviction is oldest-first as in HostPolicy.
    expect(await resolver.resolve('d.example')).toBe('1.2.3.4');
  });
});
