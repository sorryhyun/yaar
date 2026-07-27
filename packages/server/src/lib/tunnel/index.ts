import { SshTunnel } from './ssh-tunnel.js';
import { TailscaleTunnel } from './tailscale-tunnel.js';
import type { TunnelConfig, TunnelProvider } from './types.js';

export { SshTunnel } from './ssh-tunnel.js';
export { TailscaleTunnel, DEFAULT_APP_ORIGIN_PORT } from './tailscale-tunnel.js';
export { loadTunnelConfig } from './config.js';
export type { OriginPair, TunnelConfig, TunnelProvider } from './types.js';

/**
 * Pick the tunnel implementation for a config. Defaults to the localhost.run SSH tunnel.
 *
 * `appLocalPort` is the second local socket isolated app iframes are served on; pass
 * null (or omit) to run without an app origin. Only a provider that can publish two
 * origins looks at it.
 */
export function createTunnel(
  config: TunnelConfig,
  localPort: number,
  appLocalPort: number | null = null,
): TunnelProvider {
  if (config.service === 'tailscale') {
    return new TailscaleTunnel(config, localPort, undefined, appLocalPort);
  }
  return new SshTunnel(config, localPort);
}

/**
 * The factory's policy table — what a transport choice implies for the *server's*
 * own posture, answerable from config alone.
 *
 * These are questions the provider would ideally answer about itself, but both are
 * needed before any provider exists: the bind address is chosen when the socket is
 * created, and the app-origin socket has to be listening before a serve rule can
 * point at it. Keeping them here means there is still exactly one place where
 * "which service" maps to "which posture".
 */

/**
 * Does this transport reach YAAR over loopback, so a LAN bind buys nothing?
 *
 * The SSH tunnel is best-effort in front of a `0.0.0.0` bind: if it fails you still
 * have the LAN URL, which is why remote mode has always opened all interfaces.
 * `tailscaled` reaches YAAR at `127.0.0.1`, so under Tailscale the LAN bind is pure
 * extra surface — dropping it means only the tailnet (via the daemon) and localhost
 * get in.
 *
 * This is deliberately decided from *intent*, not from whether the tunnel came up:
 * a user who asked for tailnet-only should not silently get their whole LAN exposed
 * on a bearer token because `tailscaled` happened to be down. The fallback for a
 * failed Tailscale tunnel is localhost-only, not LAN-only.
 */
export function tunnelIsLoopbackOnly(config: TunnelConfig): boolean {
  return config.service === 'tailscale';
}

/**
 * Can this transport publish a *second*, stable origin for isolated app iframes?
 *
 * Only Tailscale can: MagicDNS names are stable, so a second `serve` rule on another
 * port is a durable second origin. localhost.run's subdomain rotates every start and
 * can never anchor one.
 */
export function tunnelSupportsAppOrigin(config: TunnelConfig): boolean {
  return config.service === 'tailscale';
}
