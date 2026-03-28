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
}

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
}
