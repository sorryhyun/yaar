/**
 * The local HTTPS + HTTP/2 socket: same handlers as `PORT`, over TLS on loopback.
 *
 * Over HTTP/1.1 a browser holds six connections per host, and every isolated app calls
 * the desktop origin as its API base — so a few long `/api/verb` calls (a devtools
 * preview eval, a build) queue everything else behind them and the desktop freezes.
 * h2 multiplexes them on one connection.
 *
 * The Chrome YAAR launches opens this socket, trusting the leaf's key by the SPKI that
 * `/health` advertises. Any other browser can trust it by installing the local CA that
 * signed the leaf, served at `/local-ca.crt` — the road for a phone running the server
 * under Termux, whose browser warns on every plain-http download. Plain HTTP on `PORT`
 * stays for everything else (MCP, the Tailscale backend, browsers without the CA).
 */

import { join } from 'node:path';
import { ensureLocalCert, type LocalCert } from '@yaar/lib/tls';
import { DESKTOP_ORIGIN_HOST, getConfigDir } from '../config.js';

export interface LocalTlsEndpoint {
  port: number;
  spki: string;
}

/** Offset from `PORT` the TLS socket prefers (8000 → 8443). */
export const LOCAL_TLS_PORT_OFFSET = 443;

let endpoint: LocalTlsEndpoint | null = null;
let caPem: string | null = null;

export function loadLocalTlsCert(): Promise<LocalCert | null> {
  return ensureLocalCert(join(getConfigDir(), 'local-tls'));
}

/** Record the socket once it is listening, and the CA a browser installs to trust it. */
export function setLocalTlsEndpoint(e: LocalTlsEndpoint | null, ca: string | null = null): void {
  endpoint = e;
  caPem = e ? ca : null;
}

/** The local CA (PEM) behind the TLS socket's leaf, or null when the socket is down. */
export function getLocalCaPem(): string | null {
  return caPem;
}

export function getLocalTlsEndpoint(): LocalTlsEndpoint | null {
  return endpoint;
}

/** `https://localhost:<tlsPort>` when the TLS socket is up, else null. */
export function localTlsDesktopOrigin(): string | null {
  return endpoint ? `https://${DESKTOP_ORIGIN_HOST}:${endpoint.port}` : null;
}
