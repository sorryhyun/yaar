// The MCP wire protocol: JSON-RPC framing, transport, and probing a server.
//
// Kept separate from the UI so the request/response rules live in one place —
// in particular the two headers that must ride every request after initialize.
// This module talks to *remote* servers only; everything that talks to YAAR's
// own gateway is in gateway.ts.
import { errMsg, httpFetch, safeParseOr } from '@bundled/yaar';
import { CLIENT_INFO, CLIENT_PROTOCOL_VERSION } from './constants';
import { logDebug, logError } from './log';
import { JsonRpcResponse, McpInitializeResult } from './schema';
import { parseToolList } from './tools';
import type { DiscoveredServer, McpSession } from './types';

let rpcId = 0;

function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? {} });
}

function jsonRpcNotification(method: string) {
  return JSON.stringify({ jsonrpc: '2.0', method });
}

function mcpPost(url: string, body: string, session?: McpSession): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (session?.sessionId) headers['mcp-session-id'] = session.sessionId;
  // Mandatory on every non-initialize request since the 2025-06-18 revision.
  // Omitting it makes a spec-current server assume 2025-03-26 or reject outright.
  if (session?.protocolVersion) headers['MCP-Protocol-Version'] = session.protocolVersion;
  return httpFetch(url, { method: 'POST', headers, body });
}

/** JSON.parse that answers "not JSON" with `undefined` instead of throwing. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the JSON-RPC payload out of a response body — direct JSON or SSE framing.
 *
 * Only the *decode* decides which framing this is; everything after it (schema
 * failure, and a well-formed `error` envelope) throws for the caller. That
 * separation is the point: an earlier version wrapped the whole direct-JSON
 * branch in a try whose catch fell through to the SSE scan, so a legitimate
 * `error.message` from the server — and the schema failure too — was swallowed
 * and re-reported as the generic "Could not parse MCP response". The server's
 * own explanation of what went wrong is the most useful thing in the exchange;
 * it must not be lost to control flow.
 */
export function parseRpcResponse(body: string): unknown {
  const direct = tryJson(body);
  if (direct !== undefined) {
    // `direct` is always a real parsed JSON value here (never JS `undefined`),
    // so `undefined` can only mean "failed validation" — safe to use as the
    // fallback-doubles-as-failure-signal sentinel.
    const data = safeParseOr(JsonRpcResponse, direct, undefined, {
      onInvalid: (issues) => {
        logError('JSON-RPC response failed validation', issues);
        throw new Error('Malformed MCP JSON-RPC response');
      },
    });
    if (data.result !== undefined) return data.result;
    if (data.error) throw new Error(data.error.message ?? 'JSON-RPC error');
    return data;
  }

  // Not JSON on its own — SSE framing: look for "data: {...}" lines. A line that
  // does not decode is skipped (an SSE stream legitimately carries other
  // frames); a line that fails schema validation is skipped the same way; a
  // line that decodes and *is* an error envelope throws, as above.
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const value = tryJson(line.slice(6));
    if (value === undefined) continue;
    const data = safeParseOr(JsonRpcResponse, value, undefined, {
      label: 'mcp:rpc-sse-line',
    });
    if (data === undefined) continue;
    if (data.result !== undefined) return data.result;
    if (data.error) throw new Error(data.error.message ?? 'JSON-RPC error');
  }
  throw new Error('Could not parse MCP response');
}

/**
 * Full initialize → initialized → tools/list handshake against one URL.
 *
 * Returns null when nothing MCP-shaped answers (a non-MCP service on the port,
 * a non-2xx status). Throws when something *did* answer but the exchange was
 * malformed or the server reported an error — the manual probe surfaces that
 * message, while a port scan treats it the same as silence.
 */
export async function probeUrl(url: string, port?: number): Promise<DiscoveredServer | null> {
  const initRes = await mcpPost(
    url,
    jsonRpcRequest('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }),
  );
  // httpFetch does not throw on 4xx/5xx — a non-MCP service answering here is a
  // normal scan outcome, not an error.
  if (!initRes.ok) return null;

  // The body is either JSON or an SSE stream; parseRpcResponse handles both, so
  // read it as text rather than committing to res.json().
  const initResult = safeParseOr(
    McpInitializeResult,
    parseRpcResponse(await initRes.text()),
    undefined,
    {
      onInvalid: (issues) => {
        logError(`initialize from ${url} failed validation`, issues);
        throw new Error('Malformed MCP initialize result');
      },
    },
  );

  const session: McpSession = {
    // Headers.get() is case-insensitive, unlike a plain-object lookup.
    sessionId: initRes.headers.get('mcp-session-id') ?? undefined,
    protocolVersion: initResult.protocolVersion ?? CLIENT_PROTOCOL_VERSION,
  };

  await mcpPost(url, jsonRpcNotification('notifications/initialized'), session);

  const toolsRes = await mcpPost(url, jsonRpcRequest('tools/list'), session);

  return {
    url,
    port,
    serverName: initResult.serverInfo?.name,
    serverVersion: initResult.serverInfo?.version,
    protocolVersion: session.protocolVersion,
    tools: parseToolList(parseRpcResponse(await toolsRes.text()), url),
  };
}

/**
 * Probe one port during a scan. Any failure is just "nothing here".
 *
 * The swallow is deliberate — across a sweep, an unreachable port and a
 * malformed reply are equally uninteresting — but it hides a *systemic*
 * failure just as well as an empty network, so the reason is kept at debug
 * level rather than dropped entirely.
 */
export async function probePort(
  host: string,
  port: number,
  path: string,
  /** Called with the failure reason, so a sweep can tally why it found nothing. */
  onFailure?: (reason: string) => void,
): Promise<DiscoveredServer | null> {
  const url = `http://${host}:${port}${path}`;
  try {
    return await probeUrl(url, port);
  } catch (err) {
    logDebug(`probe ${url} failed`, err);
    onFailure?.(errMsg(err));
    return null;
  }
}

/**
 * Fallback name for a server that did not report one in `serverInfo`, derived
 * from its URL so two servers on different ports never collide.
 */
export function deriveName(url: string): string {
  try {
    const parsed = new URL(url);
    return `mcp-${parsed.hostname}-${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    // Not a parseable URL. Nothing about it is worth naming, so fall back to
    // something merely unique.
    return `mcp-${Date.now()}`;
  }
}