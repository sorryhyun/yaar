/**
 * The CONNECT front door: what it parses, and what it refuses.
 *
 * The refusal cases are the ones worth holding on a real socket, because they are the
 * proxy's security surface — it is an open CONNECT listener for the lifetime of the
 * server, so "which targets will it dial" is the question that matters, and asserting
 * it through the actual socket is the only way to know the guard is *wired*, not merely
 * written. `freedpi-resolve.test.ts` covers the address rules themselves.
 *
 * Fragmentation is deliberately not asserted here. Two segments written to loopback are
 * routinely coalesced into one `read()` by the receiver — observed nondeterministically
 * on this very code — so a loopback assertion would be flaky in one direction and
 * falsely reassuring in the other. The cut itself is pinned in `freedpi-split.test.ts`,
 * where it is a pure function and the answer is exact.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { connect } from 'bun';
import { createFreeDpiProxy, parseConnect } from '../lib/freedpi/proxy.js';
import type { FreeDpiProxy } from '../lib/freedpi/types.js';

const running: FreeDpiProxy[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
});

function startProxy(): FreeDpiProxy {
  const proxy = createFreeDpiProxy({ stallMs: 10 });
  running.push(proxy);
  return proxy;
}

/** Send one request to the proxy and resolve the first response bytes. */
function ask(port: number, request: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    let seen = '';
    void connect<{ q: never[] }>({
      hostname: '127.0.0.1',
      port,
      data: { q: [] },
      socket: {
        open: (sock) => void sock.write(request),
        data(sock, chunk) {
          seen += Buffer.from(chunk).toString('latin1');
          clearTimeout(timer);
          sock.end();
          resolve(seen);
        },
        close: () => {
          clearTimeout(timer);
          resolve(seen);
        },
        error: (_s, err) => {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch(reject);
  });
}

describe('parseConnect', () => {
  it('reads host and port out of a CONNECT line', () => {
    expect(parseConnect('CONNECT pornhub.com:443 HTTP/1.1')).toEqual({
      host: 'pornhub.com',
      port: 443,
    });
  });

  it('unwraps a bracketed IPv6 literal', () => {
    expect(parseConnect('CONNECT [2606:4700::1111]:443 HTTP/1.1')).toEqual({
      host: '2606:4700::1111',
      port: 443,
    });
  });

  it('rejects other methods', () => {
    for (const line of ['GET / HTTP/1.1', 'POST /x HTTP/1.1', 'connectish foo:443 HTTP/1.1']) {
      expect(parseConnect(line)).toBeNull();
    }
  });

  it('rejects a missing or out-of-range port', () => {
    expect(parseConnect('CONNECT example.com HTTP/1.1')).toBeNull();
    expect(parseConnect('CONNECT example.com:0 HTTP/1.1')).toBeNull();
    expect(parseConnect('CONNECT example.com:99999 HTTP/1.1')).toBeNull();
  });
});

describe('proxy socket behaviour', () => {
  it('binds a loopback port and reports it as a usable proxy URL', () => {
    const proxy = startProxy();
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.proxyUrl).toBe(`http://127.0.0.1:${proxy.port}`);
  });

  it('refuses a non-CONNECT request', async () => {
    const proxy = startProxy();
    const res = await ask(proxy.port, 'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
    expect(res).toContain('405');
  });

  it('refuses to tunnel to loopback', async () => {
    // The guard being *wired*, not merely written: without it, anything on this machine
    // that finds the port inherits the proxy's reach.
    const proxy = startProxy();
    const res = await ask(proxy.port, 'CONNECT 127.0.0.1:9  HTTP/1.1\r\n\r\n');
    expect(res).toContain('403');
  });

  it('refuses to tunnel to private space', async () => {
    const proxy = startProxy();
    const res = await ask(proxy.port, 'CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n');
    expect(res).toContain('403');
  });

  it('stops cleanly and stops accepting', async () => {
    const proxy = createFreeDpiProxy({ stallMs: 10 });
    const port = proxy.port;
    proxy.stop();
    await expect(ask(port, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n', 1500)).rejects.toThrow();
  });
});
