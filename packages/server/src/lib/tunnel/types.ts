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
  /**
   * The two public origins this transport serves, when it can host a *second*
   * origin for isolated app iframes (Phase 3) — null when it cannot, or when the
   * second rule failed to register.
   *
   * A transport that can only publish one origin (the SSH tunnel: one ephemeral
   * subdomain) simply omits this method, and app-origin isolation stays off over
   * that transport exactly as before.
   */
  originBoundary?(): OriginPair | null;
}

/**
 * A desktop origin and the distinct origin isolated app iframes are served from.
 *
 * These are *browser* origins, so a difference in scheme, host, **or port** is
 * enough for the same-origin policy to separate them — which is what lets one
 * Tailscale MagicDNS name carry both (`:443` and `:8443`).
 */
export interface OriginPair {
  desktopOrigin: string;
  appOrigin: string;
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
  /**
   * Public HTTPS port the *app* origin is served on (default: 8443). Tailscale only.
   *
   * A second `tailscale serve` rule on the same MagicDNS name but a different port
   * is what gives app-origin isolation a distinct browser origin over the network
   * (Phase 3). 8443 is the default because Funnel also permits it, so a later
   * `mode: "funnel"` needs no different number.
   */
  appOriginPort?: number;
}
