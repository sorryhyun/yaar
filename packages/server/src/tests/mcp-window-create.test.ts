/**
 * Tests for the window `create` tool — specifically that iframe embed
 * failures (feedback.success === false) return an error() result with isError: true.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmitAction, mockEmitActionWithFeedback } = vi.hoisted(() => ({
  mockEmitAction: vi.fn(),
  mockEmitActionWithFeedback: vi.fn(),
}));

vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: mockEmitAction,
    emitActionWithFeedback: mockEmitActionWithFeedback,
  },
}));

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project',
}));

vi.mock('../mcp/apps/discovery.js', () => ({
  getAppMeta: vi.fn().mockResolvedValue(null),
}));

// Import after mocks are set up
import { registerCreateTools } from '../mcp/window/create.js';

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

describe('window create tool — iframe embed failure', () => {
  let server: ReturnType<typeof createMockServer>;
  let createHandler: (args: any) => Promise<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCreateTools(server as any);
    createHandler = server.getHandler('create')!;
    expect(createHandler).toBeDefined();
  });

  it('returns isError: true when iframe feedback.success is false', async () => {
    mockEmitActionWithFeedback.mockResolvedValue({
      requestId: 'req-1',
      windowId: 'test-win',
      renderer: 'iframe',
      success: false,
      error: 'Refused to display in a frame because X-Frame-Options is set to DENY',
    });

    const result = await createHandler({
      windowId: 'test-win',
      title: 'Blocked Site',
      content: { renderer: 'iframe', content: 'https://example.com' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to embed iframe');
    expect(result.content[0].text).toContain('blocks embedding');
  });

  it('returns success when iframe feedback.success is true', async () => {
    mockEmitActionWithFeedback.mockResolvedValue({
      requestId: 'req-2',
      windowId: 'test-win',
      renderer: 'iframe',
      success: true,
    });

    const result = await createHandler({
      windowId: 'test-win',
      title: 'Good Site',
      content: { renderer: 'iframe', content: 'https://embed.example.com' },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Created window');
  });

  it('returns success when iframe feedback is null (timeout)', async () => {
    mockEmitActionWithFeedback.mockResolvedValue(null);

    const result = await createHandler({
      windowId: 'test-win',
      title: 'Slow Site',
      content: { renderer: 'iframe', content: 'https://slow.example.com' },
    });

    // null feedback means timeout — treat as success (no error detected)
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Created window');
  });

  it('does not use emitActionWithFeedback for non-iframe renderers', async () => {
    const result = await createHandler({
      windowId: 'md-win',
      title: 'Markdown',
      content: { renderer: 'markdown', content: '# Hello' },
    });

    expect(mockEmitActionWithFeedback).not.toHaveBeenCalled();
    expect(mockEmitAction).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Created window "md-win"');
  });
});
