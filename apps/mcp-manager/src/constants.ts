// Every literal the app would otherwise repeat: gateway URIs and payload verbs,
// scan defaults, connection-state names, and the identity this client reports
// to a remote MCP server.
//
// Centralised so that a change to a URI or a default is a one-line edit rather
// than a grep — and so the UI never has to spell a protocol string itself.

/** The gateway resource that owns MCP config *and* live connections. */
export const MCP_URI = 'yaar://mcp';

/** The persisted server config, read for names/types/urls. */
export const MCP_CONFIG_URI = 'yaar://config/mcp';

/** Per-server tool list. The name is user-supplied, so it is escaped here. */
export function serverToolsUri(name: string): string {
  return `${MCP_URI}/${encodeURIComponent(name)}`;
}

/** Actions accepted by `invoke(MCP_URI, ...)`. */
export const MCP_ACTION = {
  add: 'add',
  remove: 'remove',
  refresh: 'refresh',
} as const;

/**
 * The only transport this app can register. A `stdio` server already in the
 * config still renders in the list, but cannot be added or reconfigured here —
 * see agent/SKILL.md.
 */
export const HTTP_TRANSPORT = 'http';

/**
 * Connection states the gateway reports. `disconnected` doubles as the default
 * for a configured server the gateway has no status row for.
 */
export const CONNECTION_STATE = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disconnected',
} as const;

/** Initial values of the scan form; `path` is also the fallback for a blank field. */
export const SCAN_DEFAULTS = {
  host: '127.0.0.1',
  from: 3000,
  to: 9000,
  path: '/mcp',
} as const;

/**
 * Ports probed concurrently per batch. A scan is a wall of HTTP requests, so it
 * is chunked: the batch bounds the in-flight count and gives the progress line
 * something to report.
 */
export const SCAN_BATCH_SIZE = 20;

/**
 * The MCP revision this client speaks. A server may negotiate *down* to an
 * older one in its initialize result; whatever comes back is what we echo in
 * the MCP-Protocol-Version header from then on, rather than asserting ours.
 */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

/** Reported to the server in `initialize`. */
export const CLIENT_INFO = { name: 'yaar-mcp-manager', version: '2.0.0' };

/** Prefix on every console line this app writes, so its logs are greppable. */
export const LOG_PREFIX = '[mcp-manager]';