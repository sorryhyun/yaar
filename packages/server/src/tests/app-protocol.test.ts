/**
 * Tests for app_query and app_command MCP tools (app-protocol.ts).
 *
 * Verifies window validation, appProtocol readiness checks, manifest queries,
 * state queries, command execution, and error/timeout handling.
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

import { registerAppProtocolTools } from '../mcp/window/app-protocol.js';

/**
 * Minimal mock of McpServer that captures registered tool handlers.
 */
function createMockServer() {
  const tools = new Map<string, { handler: (args: any) => Promise<any> }>();
  return {
    registerTool(name: string, _schema: any, handler: (args: any) => Promise<any>) {
      tools.set(name, { handler });
    },
    getHandler(name: string) {
      return tools.get(name)?.handler;
    },
  };
}

function createMockWindowState(windows: Record<string, any> = {}) {
  const commands: any[] = [];
  return {
    getWindow: vi.fn((id: string) => windows[id] ?? null),
    recordAppCommand: vi.fn((windowId: string, req: any) => {
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
  let queryHandler: (args: any) => Promise<any>;

  function setup(windows: Record<string, any> = {}) {
    server = createMockServer();
    const state = createMockWindowState(windows);
    registerAppProtocolTools(server as any, () => state as any);
    queryHandler = server.getHandler('app_query')!;
    expect(queryHandler).toBeDefined();
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when window not found', async () => {
    setup();
    const result = await queryHandler({ windowId: 'missing', stateKey: 'foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Window "missing" not found');
  });

  it('returns error when window is not an iframe', async () => {
    setup({
      'win-1': { content: { renderer: 'markdown', data: '# hi' }, appProtocol: true },
    });
    const result = await queryHandler({ windowId: 'win-1', stateKey: 'foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not an iframe app');
  });

  it('returns error when app not ready (waitForAppReady returns false)', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' } },
    });
    mockWaitForAppReady.mockResolvedValue(false);

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'foo' });
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

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'count' });
    expect(mockWaitForAppReady).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('returns manifest on successful manifest query', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const manifest = { stateKeys: ['cells'], commands: ['setCells'] };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'manifest',
      manifest,
    });

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'manifest' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(manifest);
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith('win-1', { kind: 'manifest' }, 5000);
  });

  it('returns error on manifest timeout', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    mockEmitAppProtocolRequest.mockResolvedValue(null);

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'manifest' });
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

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'manifest' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('manifest not available');
  });

  it('returns data on successful state query', async () => {
    setup({
      'win-1': { content: { renderer: 'iframe', data: 'https://example.com' }, appProtocol: true },
    });
    const data = { rows: [{ a: 1 }, { a: 2 }] };
    mockEmitAppProtocolRequest.mockResolvedValue({
      kind: 'query',
      data,
    });

    const result = await queryHandler({ windowId: 'win-1', stateKey: 'rows' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(data);
    expect(mockEmitAppProtocolRequest).toHaveBeenCalledWith(
      'win-1',
      { kind: 'query', stateKey: 'rows' },
      5000,
    );
  });
});

// ---------------------------------------------------------------------------
// app_command
// ---------------------------------------------------------------------------
describe('app_command', () => {
  let server: ReturnType<typeof createMockServer>;
  let commandHandler: (args: any) => Promise<any>;

  function setup(windows: Record<string, any> = {}) {
    server = createMockServer();
    const state = createMockWindowState(windows);
    registerAppProtocolTools(server as any, () => state as any);
    commandHandler = server.getHandler('app_command')!;
    expect(commandHandler).toBeDefined();
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when window not found', async () => {
    setup();
    const result = await commandHandler({ windowId: 'missing', command: 'doStuff' });
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
      windowId: 'win-1',
      command: 'setCells',
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

    const result = await commandHandler({ windowId: 'win-1', command: 'doStuff' });
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

    const result = await commandHandler({ windowId: 'win-1', command: 'badCmd' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('unknown command');
  });
});
