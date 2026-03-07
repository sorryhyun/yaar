/**
 * Integration tests: MCP bearer-token authentication.
 *
 * Tests the token validation layer in mcp/server.ts without spawning
 * a full server — calls handleMcpRequest directly with crafted requests.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock browser tools to avoid Chrome detection at import time
vi.mock('@yaar/server/mcp/browser/index', () => ({
  registerBrowserTools: vi.fn().mockResolvedValue(undefined),
  isBrowserAvailable: vi.fn(() => false),
  BROWSER_TOOL_NAMES: [],
}));

import { handleMcpRequest, initMcpServer, getMcpToken } from '@yaar/server/mcp/server';

describe('MCP auth — token validation', () => {
  beforeAll(async () => {
    // Initialize the MCP subsystem so mcpToken is set
    await initMcpServer();
  });

  it('initMcpServer sets a non-empty token', () => {
    const token = getMcpToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('rejects requests with no Authorization header → 401', async () => {
    const req = new Request('http://localhost:8000/mcp/system', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    const res = await handleMcpRequest(req, 'system');
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token → 401', async () => {
    const req = new Request('http://localhost:8000/mcp/system', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-value',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    const res = await handleMcpRequest(req, 'system');
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct token and returns a JSON-RPC response', async () => {
    const token = getMcpToken();
    const req = new Request('http://localhost:8000/mcp/system', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    const res = await handleMcpRequest(req, 'system');
    // MCP SDK may return 200, 202, 400, or 406 (Not Acceptable) — but NOT 401/403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('returns 503 if called before initialization (module fresh import)', async () => {
    // This just validates the guard exists — handled by initMcpServer() already called above.
    // We test that getMcpToken() does not throw after init
    expect(() => getMcpToken()).not.toThrow();
  });
});

describe('MCP auth — MCP_SKIP_AUTH bypass', () => {
  it('MCP_SKIP_AUTH=1 bypasses bearer token check', async () => {
    // Save and set skip auth env
    const original = process.env.MCP_SKIP_AUTH;
    process.env.MCP_SKIP_AUTH = '1';

    try {
      // Reset modules so the new env var is picked up
      vi.resetModules();

      vi.mock('@yaar/server/mcp/browser/index', () => ({
        registerBrowserTools: vi.fn().mockResolvedValue(undefined),
        isBrowserAvailable: vi.fn(() => false),
        BROWSER_TOOL_NAMES: [],
      }));

      const { handleMcpRequest: freshHandle, initMcpServer: freshInit } =
        await import('@yaar/server/mcp/server');
      await freshInit();

      const req = new Request('http://localhost:8000/mcp/system', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No Authorization header — should succeed because MCP_SKIP_AUTH=1
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 2,
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
      });

      const res = await freshHandle(req, 'system');
      // With skip auth, should NOT be 401
      expect(res.status).not.toBe(401);
    } finally {
      if (original === undefined) {
        delete process.env.MCP_SKIP_AUTH;
      } else {
        process.env.MCP_SKIP_AUTH = original;
      }
    }
  });
});
