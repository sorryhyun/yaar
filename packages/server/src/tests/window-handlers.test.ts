import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../handlers/uri/registry.js';
import type { VerbResult } from '../handlers/uri/registry.js';

/** Extract text from first content item. */
const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../handlers/uri/resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

// Mock action emitter
const mockEmitAction = vi.fn();
const mockEmitActionWithFeedback = vi.fn();
const mockWaitForAppReady = vi.fn();
const mockEmitAppProtocolRequest = vi.fn();
vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: (...args: unknown[]) => mockEmitAction(...args),
    emitActionWithFeedback: (...args: unknown[]) => mockEmitActionWithFeedback(...args),
    waitForAppReady: (...args: unknown[]) => mockWaitForAppReady(...args),
    emitAppProtocolRequest: (...args: unknown[]) => mockEmitAppProtocolRequest(...args),
  },
}));

// Mock session
vi.mock('../agents/session.js', () => ({
  getAgentId: () => 'agent-1',
  getSessionId: () => 'session-1',
  getMonitorId: () => '0',
}));

// Mock dependencies
vi.mock('../../uri/index.js', () => ({
  resolveResourceUri: vi.fn(),
}));
vi.mock('../http/iframe-tokens.js', () => ({
  generateIframeToken: () => 'mock-token',
}));
vi.mock('../apps/discovery.js', () => ({
  getAppMeta: () => null,
}));
vi.mock('../../config.js', () => ({
  PROJECT_ROOT: '/mock-root',
}));
vi.mock('../session/session-hub.js', () => ({
  getSessionHub: () => ({ get: () => null, getDefault: () => null }),
}));

// Build a mock WindowStateRegistry
function createMockWindowState() {
  const windows = new Map<string, any>();
  return {
    listWindows: () => Array.from(windows.values()),
    getWindow: (id: string) => windows.get(id) ?? null,
    hasWindow: (id: string) => windows.has(id),
    isLockedByOther: (id: string, agentId: string | null) => {
      const win = windows.get(id);
      if (!win?.locked) return null;
      return win.lockedBy !== agentId ? win.lockedBy : null;
    },
    recordAppCommand: vi.fn(),
    // Test helper
    _addWindow: (id: string, data: any) =>
      windows.set(id, {
        id,
        title: data.title ?? 'Test',
        bounds: data.bounds ?? { x: 0, y: 0, w: 500, h: 400 },
        content: data.content ?? { renderer: 'markdown', data: 'hello' },
        locked: data.locked ?? false,
        lockedBy: data.lockedBy ?? null,
        appProtocol: data.appProtocol ?? false,
        variant: data.variant ?? 'standard',
        dockEdge: data.dockEdge,
      }),
  };
}

let registerWindowHandlers: (registry: ResourceRegistry, getWindowState: () => any) => void;
let mockWindowState: ReturnType<typeof createMockWindowState>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockWindowState = createMockWindowState();
  mockResolveUri.mockImplementation((u: string) => {
    // Parse yaar://windows/{windowId}
    const bareMatch = u.match(/^yaar:\/\/windows\/(.+)$/);
    if (bareMatch) return { kind: 'window', monitorId: '0', windowId: bareMatch[1], sourceUri: u };
    // Bare yaar://windows or yaar://windows/
    if (u === 'yaar://windows' || u === 'yaar://windows/')
      return { kind: 'window', monitorId: '0', windowId: '', sourceUri: u };
    return null;
  });

  const mod = await import('../handlers/window.js');
  registerWindowHandlers = mod.registerWindowHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerWindowHandlers(reg, () => mockWindowState);
  return reg;
}

describe('Window domain handlers', () => {
  describe('list', () => {
    it('lists empty windows', async () => {
      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://windows');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('No windows');
    });

    it('lists empty windows via trailing slash', async () => {
      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://windows/');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('No windows');
    });

    it('lists windows with details', async () => {
      mockWindowState._addWindow('0/editor', {
        title: 'Editor',
        bounds: { x: 10, y: 20, w: 600, h: 400 },
      });

      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://windows');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Editor');
      expect(text(result)).toContain('600');
    });
  });

  describe('read', () => {
    it('reads window content', async () => {
      mockWindowState._addWindow('mywin', {
        title: 'My Window',
        content: { renderer: 'markdown', data: '# Hello' },
      });

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://windows/mywin');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.title).toBe('My Window');
      expect(body.content).toBe('# Hello');
    });

    it('returns error for missing window', async () => {
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://windows/nonexistent');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not found');
    });
  });

  describe('invoke (create)', () => {
    it('creates a window', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/my-window', {
        action: 'create',
        title: 'Test Window',
        renderer: 'markdown',
        content: '# Hi',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Created window');
      expect(mockEmitAction).toHaveBeenCalledTimes(1);
    });

    it('returns error without title', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/my-window', {
        action: 'create',
        renderer: 'markdown',
        content: '# Hi',
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('title');
    });
  });

  describe('invoke (update)', () => {
    it('updates window content', async () => {
      mockWindowState._addWindow('editor', { title: 'Editor' });
      mockEmitActionWithFeedback.mockResolvedValue({ success: true });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/editor', {
        action: 'update',
        operation: 'append',
        content: '\nnew text',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Updated');
    });

    it('returns error for locked window', async () => {
      mockWindowState._addWindow('editor', {
        title: 'Editor',
        locked: true,
        lockedBy: 'other-agent',
      });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/editor', {
        action: 'update',
        operation: 'replace',
        content: 'new content',
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('locked');
    });
  });

  describe('invoke (manage)', () => {
    it('closes a window', async () => {
      mockWindowState._addWindow('editor', { title: 'Editor' });
      mockEmitActionWithFeedback.mockResolvedValue({ success: true });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/editor', {
        action: 'close',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Closed');
    });

    it('locks a window', async () => {
      mockWindowState._addWindow('editor', { title: 'Editor' });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/editor', {
        action: 'lock',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Locked');
      expect(mockEmitAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'window.lock', windowId: 'editor' }),
      );
    });

    it('returns error when closing locked window', async () => {
      mockWindowState._addWindow('editor', {
        title: 'Editor',
        locked: true,
        lockedBy: 'other-agent',
      });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://windows/editor', {
        action: 'close',
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('locked');
    });
  });

  describe('delete', () => {
    it('closes window via delete verb', async () => {
      mockWindowState._addWindow('editor', { title: 'Editor' });
      mockEmitActionWithFeedback.mockResolvedValue({ success: true });

      const reg = createRegistry();
      const result = await reg.execute('delete', 'yaar://windows/editor');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Closed');
    });
  });

  describe('describe', () => {
    it('describes window resource', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://windows/editor');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.verbs).toContain('read');
      expect(body.verbs).toContain('invoke');
      expect(body.verbs).toContain('delete');
      expect(body.invokeSchema.properties.action).toBeDefined();
    });
  });
});
