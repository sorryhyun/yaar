/**
 * Tests for app_query and app_command MCP tools (app-protocol.ts).
 *
 * Verifies window validation, appProtocol readiness checks, manifest queries,
 * state queries, command execution, and error/timeout handling.
 *
 * All tools use URI-only addressing (no windowId/stateKey/command flat forms).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWaitForAppReady, mockEmitAppProtocolRequest } = vi.hoisted(() => ({
  mockWaitForAppReady: vi.fn(),
  mockEmitAppProtocolRequest: vi.fn(),
}));

vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    waitForAppReady: mockWaitForAppReady,
    emitAppProtocolRequest: mockEmitAppProtocolRequest,
  },
}));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import { registerAppProtocolTools } from '../mcp/window/app-protocol.js';

/**
 * Minimal mock of McpServer that captures registered tool handlers.
 */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function createMockServer() {
  const tools = new Map<string, { handler: ToolHandler }>();
  return {
    registerTool(name: string, _schema: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
    },
    getHandler(name: string) {
      return tools.get(name)?.handler;
    },
  };
}

function createMockWindowState(windows: Record<string, unknown> = {}) {
  const commands: { windowId: string; req: unknown }[] = [];
  return {
    getWindow: vi.fn((id: string) => (windows[id] ? { id, ...(windows[id] as object) } : null)),
    recordAppCommand: vi.fn((windowId: string, req: unknown) => {
      commands.push({ windowId, req });
    }),
    _commands: commands,
  };
}

// ---------------------------------------------------------------------------
// app_query
// ---------------------------------------------------------------------------
describe('app_query', () => {
  let server: ReturnType<typeof createMockServer>;
  let queryHandler: ToolHandler;

  function setup(windows: Record<string, unknown> = {}) {
    server = createMockServer();
    const state = createMockWindowState(windows);
    registerAppProtocolTools(
      server as unknown as McpServer,
      () => state as unknown as WindowStateRegistry,
    );
    queryHandler = server.getHandler('app_query')!;
    expect(queryHandler).toBeDefined();
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when window not found (bare ID)', async () => {
    setup();
    const result = await queryHandler({ uri: 'missing' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Window "missing" not found');
  });

  it('returns error when window is not an iframe', async () => {
    setup({
      'win-1': { content: { renderer: 'markdown', data: '# hi' }, appProtocol: true },
    });
    const result = await queryHandler({ uri: 'win-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not an iframe app');
  });

  it('returns error when app not ready (waitForAppReady returns false)', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' } },
    });
    mockWaitForAppReady.mockResolvedValue(false);

    const result = await queryHandler({ uri: 'win-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('App did not register');
    expect(mockWaitForAppReady).toHaveBeenCalledWith('win-1', 5000);
  });

  it('skips waitForAppReady when window has appProtocol: true', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'query',
      data: { count: 42 },
    });

    const result = await queryHandler({ uri: 'yaar://monitor-0/win-1/state/count' });
    expect(mockWaitForAppReady).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('returns manifest on bare window URI', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const manifest = { stateKeys: ['cells'], commands: ['setCells'] };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'manifest',
      manifest,
    });

    const result = await queryHandler({ uri: 'yaar://monitor-0/win-1' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(manifest);
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith('win-1', { kind: 'manifest' }, 5000);
  });

  it('returns manifest on plain window ID (fallback)', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const manifest = { stateKeys: ['cells'] };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'manifest',
      manifest,
    });

    const result = await queryHandler({ uri: 'win-1' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(manifest);
  });

  it('returns error on manifest timeout', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue(null);

    const result = await queryHandler({ uri: 'win-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('manifest request (timeout)');
  });

  it('returns error when manifest response has error field', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'manifest',
      error: 'manifest not available',
    });

    const result = await queryHandler({ uri: 'win-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('manifest not available');
  });

  it('returns data on successful state query via resource URI', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const data = { rows: [{ a: 1 }, { a: 2 }] };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'query',
      data,
    });

    const result = await queryHandler({ uri: 'yaar://monitor-0/win-1/state/rows' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(data);
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith(
      'win-1',
      { kind: 'query', stateKey: 'rows' },
      5000,
    );
  });

  it('returns data on bare {windowId}/state/{key} URI', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'query',
      data: { value: 'test' },
    });

    const result = await queryHandler({ uri: 'win-1/state/value' });
    expect(result.isError).toBeUndefined();
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith(
      'win-1',
      { kind: 'query', stateKey: 'value' },
      5000,
    );
  });

  it('returns error when resource URI points to a command', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });

    const result = await queryHandler({ uri: 'yaar://monitor-0/win-1/commands/save' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Use app_command instead');
  });
});

// ---------------------------------------------------------------------------
// app_command
// ---------------------------------------------------------------------------
describe('app_command', () => {
  let server: ReturnType<typeof createMockServer>;
  let commandHandler: ToolHandler;

  function setup(windows: Record<string, unknown> = {}) {
    server = createMockServer();
    const state = createMockWindowState(windows);
    registerAppProtocolTools(
      server as unknown as McpServer,
      () => state as unknown as WindowStateRegistry,
    );
    commandHandler = server.getHandler('app_command')!;
    expect(commandHandler).toBeDefined();
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for invalid command URI (bare window ID without command path)', async () => {
    setup();
    const result = await commandHandler({ uri: 'win-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid command URI');
  });

  it('supports bare {windowId}/commands/{name} URI', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'command',
      result: { ok: true },
    });

    const result = await commandHandler({
      uri: 'win-1/commands/setTitle',
      params: { title: 'Hello' },
    });

    expect(result.isError).toBeUndefined();
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith(
      'win-1',
      { kind: 'command', command: 'setTitle', params: { title: 'Hello' } },
      5000,
    );
  });

  it('supports monitor-prefixed bare URI without yaar://', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'command',
      result: { done: true },
    });

    const result = await commandHandler({
      uri: 'monitor-0/win-1/commands/save',
    });

    expect(result.isError).toBeUndefined();
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith(
      'win-1',
      { kind: 'command', command: 'save', params: undefined },
      5000,
    );
  });

  it('returns error when window not found', async () => {
    setup();
    const result = await commandHandler({ uri: 'yaar://monitor-0/missing/commands/doStuff' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Window "missing" not found');
  });

  it('successful command returns result and calls recordAppCommand', async () => {
    const state = setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const commandResult = { updated: true };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'command',
      result: commandResult,
    });

    const result = await commandHandler({
      uri: 'yaar://monitor-0/win-1/commands/setCells',
      params: { range: 'A1:B2' },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(commandResult);
    expect(state.recordAppCommand).toHaveBeenCalledWith('win-1', {
      kind: 'command',
      command: 'setCells',
      params: { range: 'A1:B2' },
    });
  });

  it('command timeout returns error', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue(null);

    const result = await commandHandler({ uri: 'yaar://monitor-0/win-1/commands/doStuff' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not respond (timeout)');
  });

  it('command with error response returns error', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'command',
      error: 'unknown command',
    });

    const result = await commandHandler({ uri: 'yaar://monitor-0/win-1/commands/badCmd' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('unknown command');
  });
});
