/**
 * Types for external MCP server connections.
 */

/** Transport type for an external MCP server. */
export type McpTransportType = 'stdio' | 'http';

/** Configuration for a single external MCP server. */
export interface McpServerConfig {
  /** Transport type. */
  type: McpTransportType;
  /** For stdio: command to spawn. */
  command?: string;
  /** For stdio: command arguments. */
  args?: string[];
  /** For stdio: environment variables. Values starting with "$" resolve from process.env. */
  env?: Record<string, string>;
  /** For stdio: working directory. */
  cwd?: string;
  /** For http: server URL. */
  url?: string;
  /** For http: extra request headers. */
  headers?: Record<string, string>;
  /**
   * For http: OAuth client settings (`oauth.ts`). Omitted, the server is still signed in to
   * when it asks — dynamic registration, public client. `false` never offers OAuth, for a
   * server whose static `headers` are the whole story.
   */
  oauth?: McpOAuthConfig | false;
}

/** OAuth client settings for one http server. Every field is optional. */
export interface McpOAuthConfig {
  /** A client pre-registered with the server's authorization server — skips dynamic registration. */
  clientId?: string;
  /** Its secret, if confidential. `"$NAME"` resolves from process.env. */
  clientSecret?: string;
  /** Scope to request. Omitted, the SDK picks from the server's own metadata. */
  scope?: string;
}

/** Where a server stands with OAuth. Absent: the server has never asked for it. */
export type McpAuthState = 'signed_in' | 'required';

/** Full config file shape: server name -> config. */
export type McpServersConfig = Record<string, McpServerConfig>;

/** Cached tool metadata from an external MCP server. */
export interface CachedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Connection state for an external MCP server. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Status info for an external MCP server. */
export interface McpServerStatus {
  name: string;
  type: McpTransportType;
  state: ConnectionState;
  error?: string;
  toolCount?: number;
  /** OAuth standing, for http servers that use it. `required` means sign in first. */
  auth?: McpAuthState;
}
