import { SshTunnel } from './ssh-tunnel.js';
import { TailscaleTunnel } from './tailscale-tunnel.js';
import type { TunnelConfig, TunnelProvider } from './types.js';

export { SshTunnel } from './ssh-tunnel.js';
export { TailscaleTunnel } from './tailscale-tunnel.js';
export { loadTunnelConfig } from './config.js';
export type { TunnelConfig, TunnelProvider } from './types.js';

/** Pick the tunnel implementation for a config. Defaults to the localhost.run SSH tunnel. */
export function createTunnel(config: TunnelConfig, localPort: number): TunnelProvider {
  if (config.service === 'tailscale') {
    return new TailscaleTunnel(config, localPort);
  }
  return new SshTunnel(config, localPort);
}
