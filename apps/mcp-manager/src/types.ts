// Domain types shared across the layers.
//
// Distinct from schema.ts on purpose: these are the *internal* shapes the app
// passes around, while schema.ts validates the *external* shapes it receives.
// The boundary code converts one into the other, so a remote server changing
// its payload never propagates a type change through the UI.

/** One tool advertised by a server. `name` renders; `description` decorates. */
export interface McpTool {
  name: string;
  description?: string;
}

/** A server found by a scan or a probe, not necessarily configured. */
export interface DiscoveredServer {
  url: string;
  /** Present for scan results, absent for a hand-entered URL. */
  port?: number;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  tools: McpTool[];
}

/** Per-connection state from `initialize`, required on every later request. */
export interface McpSession {
  sessionId?: string;
  protocolVersion?: string;
}

/**
 * A configured server as the UI shows it: identity and transport from the
 * persisted config, `state`/`error`/`toolCount` joined in from live gateway
 * status.
 */
export interface McpServer {
  name: string;
  type: string;
  /** From the persisted config; dedupes scan results against what's configured. */
  url?: string;
  state: string;
  error?: string;
  toolCount?: number;
}