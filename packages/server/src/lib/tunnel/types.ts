/**
 * A tunnel exposes the local server at a public URL. Implementations own their
 * own transport and resilience; the lifecycle only ever calls these four
 * methods, so any provider that honors this contract drops in.
 */
export interface TunnelProvider {
  /** Establish the tunnel. Resolves true on success, false on any failure. */
  connect(): Promise<boolean>;
  /** Whether the tunnel is currently up. */
  isConnected(): boolean;
  /** Public connect URL with the remote auth token embedded in the hash. */
  getPublicUrl(token: string): string;
  /** Tear the tunnel down (best-effort, bounded). */
  shutdown(): Promise<void>;
}

export interface TunnelConfig {
  /** Use a managed tunnel service instead of a custom SSH server */
  service?: 'localhost.run' | 'tailscale';
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
  /** Path to the `tailscale` binary (default: discovered on PATH). Tailscale service only. */
  tailscalePath?: string;
}
