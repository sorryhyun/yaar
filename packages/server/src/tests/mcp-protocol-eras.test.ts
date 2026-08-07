/**
 * The MCP endpoint serves two protocol eras off one URL, and this pins both.
 *
 * `mcp/server.ts` forks per request: a stateless 2026-07-28 client (one that probes
 * `server/discover`) reaches `createMcpHandler`, while a 2025-era client keeps the
 * stateful `initialize` + `mcp-session-id` transport it has always had. The fork is easy
 * to break in a way nothing else notices — a modern probe that lands on the legacy branch
 * is answered "no session ID and not an initialize request", and the SDK client *silently
 * falls back* to 2025-11-25 rather than failing. So asserting "it connected and listed
 * tools" is not enough; each case asserts the negotiated revision by name.
 *
 * The legacy row is the one that guards a real regression: serving 2025-era traffic
 * statelessly would drop the session and the GET common stream that `mcp/server.ts`'s
 * keep-alive exists to hold open, which is what Claude's CLI and a default Codex use.
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
 * `server/discover` first; omitting `versionNegotiation` is the 2025-era default, which
 * is what today's Claude/Codex clients send.
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

describe('MCP protocol eras', () => {
  beforeAll(async () => {
    await initMcpServer();
  });

  it('serves 2026-07-28 to a negotiating client', async () => {
    const result = await connectAndReport('auto');
    expect(result.negotiated).toBe('2026-07-28');
    // The modern leg must expose the same surface, not an empty/degraded one.
    expect(result.toolNames).toContain('describe');
    expect(result.toolNames).toContain('invoke');
    await result.close();
  });

  it('still serves the stateful 2025-era session to a legacy client', async () => {
    const result = await connectAndReport(undefined);
    expect(result.negotiated).toBe('2025-11-25');
    expect(result.toolNames).toContain('describe');
    expect(result.toolNames).toContain('invoke');
    await result.close();
  });

  it('offers both eras the identical tool surface', async () => {
    const modern = await connectAndReport('auto');
    const legacy = await connectAndReport(undefined);
    expect(modern.toolNames).toEqual(legacy.toolNames);
    await modern.close();
    await legacy.close();
  });
});
