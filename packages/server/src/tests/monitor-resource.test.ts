import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../uri/registry.js';
import type { VerbResult } from '../uri/registry.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../uri/resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

// Mock window state
const mockWindowState = {
  listWindows: vi.fn().mockReturnValue([
    {
      id: '0/win-storage',
      title: 'Storage',
      bounds: { x: 100, y: 100, w: 500, h: 400 },
      content: { renderer: 'iframe', data: '/api/apps/storage/index.html' },
      locked: false,
      lockedBy: null,
    },
    {
      id: '0/win-notes',
      title: 'Notes',
      bounds: { x: 200, y: 200, w: 400, h: 300 },
      content: { renderer: 'markdown', data: '# Notes' },
      locked: false,
      lockedBy: null,
    },
    {
      id: '1/win-chat',
      title: 'Chat',
      bounds: { x: 100, y: 100, w: 600, h: 500 },
      content: { renderer: 'html', data: '<div>Chat</div>' },
      locked: false,
      lockedBy: null,
    },
  ]),
  getWindow: vi.fn(),
  hasWindow: vi.fn(),
  isLockedByOther: vi.fn(),
};

// Mock context pool
const mockPool = {
  getStats: vi.fn().mockReturnValue({
    totalAgents: 2,
    idleAgents: 1,
    busyAgents: 1,
    mainAgent: true,
    windowAgents: 1,
    ephemeralAgents: 0,
    mainQueueSize: 1,
    windowQueueSizes: {},
    contextTapeSize: 10,
    timelineSize: 5,
    monitorBudget: {},
  }),
  hasMainAgent: vi.fn(),
};

vi.mock('../agents/session.js', () => ({
  getAgentId: () => 'agent-0',
  getSessionId: () => 'test-session',
  getMonitorId: () => '0',
}));

vi.mock('../session/session-hub.js', () => ({
  getSessionHub: () => ({
    get: () => ({
      getPool: () => mockPool,
      windowState: mockWindowState,
    }),
    getDefault: () => null,
  }),
}));

vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: vi.fn(),
    emitActionWithFeedback: vi.fn().mockResolvedValue(null),
    waitForAppReady: vi.fn(),
    emitAppProtocolRequest: vi.fn(),
  },
}));

vi.mock('../mcp/apps/discovery.js', () => ({
  getAppMeta: vi.fn().mockResolvedValue(null),
}));

vi.mock('../http/iframe-tokens.js', () => ({
  generateIframeToken: vi.fn().mockReturnValue('tok'),
}));

let registerWindowHandlers: (
  registry: ResourceRegistry,
  getWindowState: () => typeof mockWindowState,
) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    // Monitor-only URI: yaar://monitors/0
    const monitorMatch = u.match(/^yaar:\/\/monitors\/([^/]+)$/);
    if (monitorMatch) {
      return { kind: 'monitor', monitorId: monitorMatch[1], sourceUri: u };
    }
    // Window URI: yaar://monitors/0/win-1
    const windowMatch = u.match(/^yaar:\/\/monitors\/([^/]+)\/([^/]+)$/);
    if (windowMatch) {
      return { kind: 'window', monitorId: windowMatch[1], windowId: windowMatch[2], sourceUri: u };
    }
    // Monitor list
    if (u === 'yaar://monitors' || u === 'yaar://monitors/') {
      return { kind: 'monitor', monitorId: '', sourceUri: u };
    }
    return null;
  });

  const mod = await import('../mcp/window/handlers.js');
  registerWindowHandlers = mod.registerWindowHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerWindowHandlers(reg, () => mockWindowState);
  return reg;
}

describe('Monitor-as-resource', () => {
  it('reads monitor status for a specific monitor', async () => {
    mockPool.hasMainAgent.mockReturnValue(true);

    const reg = createRegistry();
    const result = await reg.execute('read', 'yaar://monitors/0');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.monitorId).toBe('0');
    expect(data.hasMainAgent).toBe(true);
    // Should only include windows from monitor 0
    expect(data.windows).toHaveLength(2);
    expect(data.windows[0].title).toBe('Storage');
    expect(data.windows[1].title).toBe('Notes');
  });

  it('filters windows by monitor ID', async () => {
    mockPool.hasMainAgent.mockReturnValue(false);

    const reg = createRegistry();
    const result = await reg.execute('read', 'yaar://monitors/1');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.monitorId).toBe('1');
    expect(data.hasMainAgent).toBe(false);
    // Should only include windows from monitor 1
    expect(data.windows).toHaveLength(1);
    expect(data.windows[0].title).toBe('Chat');
  });

  it('returns empty windows for unknown monitor', async () => {
    mockPool.hasMainAgent.mockReturnValue(false);

    const reg = createRegistry();
    const result = await reg.execute('read', 'yaar://monitors/99');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.monitorId).toBe('99');
    expect(data.windows).toHaveLength(0);
  });
});
