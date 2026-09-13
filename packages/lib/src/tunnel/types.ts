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
   * origin for isolated app iframes — null when the second rule failed to register.
   *
   * A transport that can only publish one origin (an ephemeral-subdomain service,
   * say) simply omits this method, and app-origin isolation stays off over it.
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

/**
 * Tunnel configuration, as read from `config/tunnel.json`.
 *
 * Tailscale Serve is the transport YAAR ships. It gives remote mode two things
 * nothing else did: tailnet membership as network-layer auth, and a hostname
 * stable enough to anchor the second origin app-origin isolation needs.
 */
export interface TunnelConfig {
  /** The transport. Only `tailscale` exists; the field is kept for forward compat. */
  service?: 'tailscale';
  /** Path to the `tailscale` binary (default: discovered on PATH). */
  tailscalePath?: string;
  /**
   * Public HTTPS port the *app* origin is served on (default: 8443).
   *
   * A second `tailscale serve` rule on the same MagicDNS name but a different port
   * is what gives app-origin isolation a distinct browser origin over the network.
   * 8443 is the default because Funnel also permits it, so a later `mode: "funnel"`
   * needs no different number.
   */
  appOriginPort?: number;
}
