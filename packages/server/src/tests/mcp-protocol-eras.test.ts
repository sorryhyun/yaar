/**
 * The MCP endpoint serves one protocol era — 2026-07-28 — and this pins both halves of
 * that: what a negotiating client gets, and what a client that cannot negotiate gets told.
 *
 * The first row is the one that guards a silent regression. A modern probe that lands on
 * the wrong branch is answered with an error the SDK client treats as "server is old", so
 * it *silently falls back* to a 2025-era `initialize` rather than failing. Asserting "it
 * connected and listed tools" would therefore pass on a broken fork; each case asserts the
 * negotiated revision by name.
 *
 * The refusal rows exist because the stateful leg that used to absorb that fallback is
 * gone. Its removal is only safe while the failure is legible, so the refusal is asserted
 * as *content* — it must name the provider gates a reader has to go set — not merely as a
 * non-200.
 *
 * Driven through the real `handleMcpRequest` over a loopback socket with the real SDK
 * client, because the thing under test is HTTP dispatch — a hand-built Request would let
 * the classifier see a shape no client actually sends.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest, initMcpServer, getMcpToken } from '../mcp/server.js';

/** Serve `handleMcpRequest` for the `verbs` namespace on an ephemeral port. */
function serve() {
  return Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: (req) => handleMcpRequest(req, 'verbs'),
  });
}

/**
 * Connect a client and report what it negotiated. `mode: 'auto'` makes the SDK probe
 * `server/discover` first; omitting `versionNegotiation` is the 2025-era default, which is
 * what a stale CLI — or one whose opt-in gate was withdrawn — still sends.
 */
async function connectAndReport(mode: 'auto' | undefined) {
  const server = serve();
  const token = getMcpToken();
  const client = new Client(
    { name: 'era-test', version: '1.0.0' },
    mode ? { versionNegotiation: { mode } } : undefined,
  );
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    return {
      negotiated: (client as unknown as { _negotiatedProtocolVersion?: string })
        ._negotiatedProtocolVersion,
      toolNames: tools.tools.map((t) => t.name).sort(),
      close: async () => {
        await client.close();
        server.stop(true);
      },
    };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

/** POST a raw body to the endpoint, optionally carrying a session id. */
async function post(body: unknown, headers: Record<string, string> = {}) {
  const server = serve();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${getMcpToken()}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { error?: { message?: string } } };
  } finally {
    server.stop(true);
  }
}

const LEGACY_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stale-cli', version: '0.0.1' },
  },
};

describe('MCP protocol era', () => {
  beforeAll(async () => {
    await initMcpServer();
  });

  it('serves 2026-07-28 to a negotiating client', async () => {
    const result = await connectAndReport('auto');
    expect(result.negotiated).toBe('2026-07-28');
    // The stateless leg must expose the full surface, not a degraded one.
    expect(result.toolNames).toContain('describe');
    expect(result.toolNames).toContain('invoke');
    await result.close();
  });

  it('refuses a legacy initialize, naming both provider gates', async () => {
    const { status, json } = await post(LEGACY_INITIALIZE);
    expect(status).toBe(400);
    const message = json.error?.message ?? '';
    // The refusal is the only signpost left now that the fallback is gone: someone reading
    // it must learn which knob to go set, per provider.
    expect(message).toContain('MCP_SDK_GENERATION');
    expect(message).toContain('MCP_PROTOCOL_NEGOTIATION');
    expect(message).toContain('features.mcp_2026_07_28');
  });

  it('refuses a request carrying an mcp-session-id', async () => {
    // Only the retired stateful leg ever minted one, so its presence is legacy by
    // construction — and is rejected before the body is even read.
    const { status, json } = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': 'deadbeef' },
    );
    expect(status).toBe(400);
    expect(json.error?.message ?? '').toContain('2026-07-28');
  });

  it('gives a non-negotiating SDK client a hard failure, not a silent fallback', async () => {
    // The whole risk of modern-only in one assertion: the client that used to quietly
    // re-handshake now cannot connect at all.
    await expect(connectAndReport(undefined)).rejects.toThrow();
  });
});
