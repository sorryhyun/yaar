/**
 * SSH reverse tunnel configuration types.
 */

export interface TunnelConfig {
  /** Use a managed tunnel service instead of a custom SSH server */
  service?: 'localhost.run';
  /** Disable auto-tunneling (only meaningful in config/tunnel.json) */
  disabled?: boolean;
  /** SSH server hostname (required for custom server, ignored for service) */
  host?: string;
  /** SSH port (default: 22) */
  port?: number;
  /** SSH username (required for custom server, ignored for service) */
  username?: string;
  /** Path to private key (~ resolved to homedir) */
  privateKeyPath?: string;
  /** Password auth fallback */
  password?: string;
  /** Port on remote server to forward (default: same as local PORT) */
  remotePort?: number;
  /** Bind address on remote server (default: "0.0.0.0") */
  remoteHost?: string;
  /** Public hostname for constructing the URL (default: same as host) */
  publicHost?: string;
  /** Use https:// in the public URL (default: false) */
  publicHttps?: boolean;
}
