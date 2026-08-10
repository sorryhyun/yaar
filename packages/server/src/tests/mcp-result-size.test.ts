/**
 * The content-bearing MCP tools declare their own persist-to-disk threshold.
 *
 * Unannotated, Claude Code clamps an MCP tool result at 50,000 characters, writes anything
 * bigger to `~/.claude/projects/{…}/tool-results/{id}.txt`, and hands the model a 2 KB
 * preview plus that path. Every YAAR principal — monitor agents with five `yaar://` verbs,
 * app agents with four scoped tools — holds no filesystem read, so the pointer is a dead end
 * and the result is *gone*, not merely truncated. `_meta["anthropic/maxResultSizeChars"]`
 * is the documented way for a server to raise its own threshold; see `mcp/result-size.ts`.
 *
 * This is asserted over the wire rather than against the registration call, because the
 * failure it guards is silent in both directions: the SDK dropping `_meta` from `tools/list`,
 * or someone adding a tool that returns app content without the annotation, both look exactly
 * like a working server right up until a large read vanishes mid-session.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest, initMcpServer, getMcpToken } from '../mcp/server.js';
import { MCP_MAX_RESULT_CHARS } from '../mcp/result-size.js';

const META_KEY = 'anthropic/maxResultSizeChars';

/** Tools whose result carries resource or app content back to a model. */
const ANNOTATED: Record<string, string[]> = {
  verbs: ['describe', 'read', 'list', 'invoke'],
  app: ['describe', 'query', 'command'],
};

/** Tools that answer with a fixed-size acknowledgement and deliberately go unannotated. */
const UNANNOTATED: Record<string, string[]> = {
  verbs: ['delete'],
  app: ['relay'],
};

/** List a namespace's tools through the real HTTP dispatch and SDK client. */
async function listTools(namespace: 'verbs' | 'app') {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: (req) => handleMcpRequest(req, namespace),
  });
  const client = new Client({ name: 'result-size-test', version: '1.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${getMcpToken()}` } } },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close().catch(() => {});
    await server.stop(true);
  }
}

describe('MCP result-size annotation', () => {
  beforeAll(async () => {
    await initMcpServer();
  });

  it('is well under the ceiling that makes it useless', () => {
    // 500,000 is the CLI's hard ceiling for the annotation, but a second, un-annotatable
    // budget persists the largest results once one assistant message's results total
    // ~200,000 characters — so anything above that clears this check and is persisted
    // anyway. The value has to leave room for a sibling call in the same turn.
    expect(MCP_MAX_RESULT_CHARS).toBeGreaterThan(50_000);
    expect(MCP_MAX_RESULT_CHARS).toBeLessThan(200_000);
  });

  for (const namespace of ['verbs', 'app'] as const) {
    it(`declares ${META_KEY} on the ${namespace} content tools`, async () => {
      const tools = await listTools(namespace);
      const byName = new Map(tools.map((t) => [t.name, t]));

      for (const name of ANNOTATED[namespace]!) {
        const tool = byName.get(name);
        expect(tool, `${namespace}/${name} is registered`).toBeDefined();
        expect(tool!._meta?.[META_KEY], `${namespace}/${name} declares ${META_KEY}`).toBe(
          MCP_MAX_RESULT_CHARS,
        );
      }

      for (const name of UNANNOTATED[namespace]!) {
        const tool = byName.get(name);
        expect(tool, `${namespace}/${name} is registered`).toBeDefined();
        expect(tool!._meta?.[META_KEY]).toBeUndefined();
      }
    });
  }
});
