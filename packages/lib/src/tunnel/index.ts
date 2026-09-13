import { TailscaleTunnel } from './tailscale-tunnel.js';
import type { TunnelConfig, TunnelProvider } from './types.js';

export { TailscaleTunnel, DEFAULT_APP_ORIGIN_PORT } from './tailscale-tunnel.js';
export { loadTunnelConfig } from './config.js';
export type { OriginPair, TunnelConfig, TunnelProvider } from './types.js';

/**
 * The transport remote mode uses when `config/tunnel.json` doesn't say otherwise.
 *
 * Tailscale Serve is the only one YAAR ships. The SSH reverse tunnel it replaced
 * (`localhost.run`, or a custom SSH server) put a public URL on the internet and
 * asked a bearer token to hold the door; a tailnet asks for device membership
 * *before* the request reaches YAAR, and its stable MagicDNS name is what lets
 * app-origin isolation survive over the network at all.
 */
export const DEFAULT_TUNNEL: TunnelConfig = { service: 'tailscale' };

/**
 * Build the tunnel implementation for a config.
 *
 * `appLocalPort` is the second local socket isolated app iframes are served on; pass
 * null (or omit) to run without an app origin.
 *
 * `TunnelProvider` stays an interface with exactly one implementation on purpose —
 * a second transport drops in here, and the posture questions its choice implies
 * (loopback-only bind? second origin?) come back as a policy table alongside it.
 * See `lifecycle.getBindHostname()` / `wantsAppOriginSocket()`, which answer both
 * for Tailscale today.
 */
export function createTunnel(
  config: TunnelConfig,
  localPort: number,
  appLocalPort: number | null = null,
): TunnelProvider {
  return new TailscaleTunnel(config, localPort, undefined, appLocalPort);
}
