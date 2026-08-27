/**
 * ClientHello fragmentation — the two properties the bypass actually rests on.
 *
 * The useful one is negative: after the split, *no single segment contains the
 * hostname*. That is the whole mechanism against a middlebox that matches SNI per
 * segment, and it is why the cut has to land inside the name rather than adjacent to
 * it — a plan that cut at the name's first byte would still pass every "it produced
 * two segments" assertion while leaving the name intact and matchable.
 *
 * The other is that fragmentation is byte-preserving. A dropped or duplicated byte
 * would not fail visibly here; it would surface as a TLS handshake that mysteriously
 * fails only for split hosts, which is a miserable thing to debug from the outside.
 */

import { describe, it, expect } from 'bun:test';
import { isClientHello, findHostname, planSplit, segmentsFor } from '../lib/freedpi/split.js';

/** A synthetic ClientHello: real framing, the hostname where SNI would put it. */
function clientHello(host: string): Uint8Array {
  const name = Buffer.from(host, 'utf8');
  const body = Buffer.concat([
    Buffer.from([0x01]), // client_hello
    Buffer.alloc(3), // length
    Buffer.from([0x03, 0x03]), // client version
    Buffer.alloc(32, 0xab), // random
    Buffer.from([0x00]), // session id length
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher suites
    Buffer.from([0x01, 0x00]), // compression
    Buffer.from([0x00, 0x00]), // extension type: server_name
    Buffer.from([name.length + 5]), // ext length (low byte is enough here)
    Buffer.from([0x00, 0x00, 0x00, 0x00, name.length]),
    name,
    Buffer.alloc(64, 0x07), // trailing extensions
  ]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]), body]));
}

describe('isClientHello', () => {
  it('accepts a handshake record carrying client_hello', () => {
    expect(isClientHello(clientHello('example.com'))).toBe(true);
  });

  it('rejects application data and short payloads', () => {
    expect(isClientHello(new Uint8Array([0x17, 0x03, 0x03, 0x00, 0x10, 0x01]))).toBe(false);
    expect(isClientHello(new Uint8Array([0x16, 0x03]))).toBe(false);
    expect(isClientHello(new Uint8Array())).toBe(false);
  });

  it('rejects a handshake record that is not a client_hello', () => {
    // Byte 5 is server_hello (0x02); fragmenting the server's flight is meaningless.
    expect(isClientHello(new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x40, 0x02, 0x00]))).toBe(false);
  });
});

describe('findHostname', () => {
  it('finds the cleartext name and reports absence honestly', () => {
    const hello = clientHello('pornhub.com');
    expect(findHostname(hello, 'pornhub.com')).toBeGreaterThan(0);
    // An ECH'd or resumed hello carries no cleartext name — -1, not a guess.
    expect(findHostname(hello, 'absent.example')).toBe(-1);
    expect(findHostname(hello, '')).toBe(-1);
  });
});

describe('planSplit', () => {
  it('cuts strictly inside the hostname', () => {
    const host = 'pornhub.com';
    const hello = clientHello(host);
    const plan = planSplit(hello, host);
    const at = findHostname(hello, host);

    expect(plan.strategy).toBe('sni');
    expect(plan.cuts).toHaveLength(1);
    // Strictly between the first and last byte of the name — not merely "somewhere".
    expect(plan.cuts[0]).toBeGreaterThan(at);
    expect(plan.cuts[0]).toBeLessThan(at + host.length);
  });

  it('leaves no segment containing the hostname', () => {
    for (const host of ['pornhub.com', 'a.co', 'very-long-subdomain.example.org']) {
      const hello = clientHello(host);
      const segments = segmentsFor(hello, planSplit(hello, host));
      expect(segments.length).toBeGreaterThan(1);
      for (const segment of segments) {
        expect(Buffer.from(segment).includes(host)).toBe(false);
      }
    }
  });

  it('falls back to an offset cut when the name is not in the payload', () => {
    const hello = clientHello('example.com');
    const plan = planSplit(hello, 'not-in-there.example');
    expect(plan.strategy).toBe('fallback');
    expect(plan.cuts).toEqual([1]);
  });

  it('does not fragment what is not a client_hello', () => {
    const appData = new Uint8Array([0x17, 0x03, 0x03, 0x00, 0x05, 0x00, 0x01, 0x02]);
    expect(planSplit(appData, 'example.com')).toEqual({ cuts: [], strategy: 'none' });
  });

  it('refuses to cut a one-byte hostname into nothing', () => {
    // `host.length >= 2` guards this: a 1-char name has no interior to cut at.
    const hello = clientHello('x');
    expect(planSplit(hello, 'x').strategy).toBe('fallback');
  });
});

describe('segmentsFor', () => {
  it('preserves every byte in order', () => {
    const host = 'pornhub.com';
    const hello = clientHello(host);
    const joined = Buffer.concat(segmentsFor(hello, planSplit(hello, host)));
    expect(joined.equals(Buffer.from(hello))).toBe(true);
  });

  it('returns the payload whole when there is nothing to cut', () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(segmentsFor(payload, { cuts: [], strategy: 'none' })).toEqual([payload]);
  });

  it('drops empty segments a degenerate cut would produce', () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(segmentsFor(payload, { cuts: [0], strategy: 'fallback' })).toHaveLength(1);
  });
});
