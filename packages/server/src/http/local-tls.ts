/**
 * The local HTTPS + HTTP/2 socket: same handlers as `PORT`, over TLS on loopback.
 *
 * Over HTTP/1.1 a browser holds six connections per host, and every isolated app calls
 * the desktop origin as its API base — so a few long `/api/verb` calls (a devtools
 * preview eval, a build) queue everything else behind them and the desktop freezes.
 * h2 multiplexes them on one connection.
 *
 * The Chrome YAAR launches opens this socket, trusting the self-signed key by the SPKI
 * that `/health` advertises. Plain HTTP on `PORT` stays for everything else (MCP, the
 * Tailscale backend, other browsers).
 */

import { join } from 'node:path';
import { ensureSelfSignedCert, type SelfSignedCert } from '@yaar/lib/tls';
import { DESKTOP_ORIGIN_HOST, getConfigDir } from '../config.js';

export interface LocalTlsEndpoint {
  port: number;
  spki: string;
}

/** Offset from `PORT` the TLS socket prefers (8000 → 8443). */
export const LOCAL_TLS_PORT_OFFSET = 443;

let endpoint: LocalTlsEndpoint | null = null;

export function loadLocalTlsCert(): Promise<SelfSignedCert | null> {
  return ensureSelfSignedCert(join(getConfigDir(), 'local-tls'));
}

export function setLocalTlsEndpoint(e: LocalTlsEndpoint | null): void {
  endpoint = e;
}

export function getLocalTlsEndpoint(): LocalTlsEndpoint | null {
  return endpoint;
}

/** `https://localhost:<tlsPort>` when the TLS socket is up, else null. */
export function localTlsDesktopOrigin(): string | null {
  return endpoint ? `https://${DESKTOP_ORIGIN_HOST}:${endpoint.port}` : null;
}
