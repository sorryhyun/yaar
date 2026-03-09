import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../handlers/uri/registry.js';
import type { VerbResult } from '../handlers/uri/registry.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../handlers/uri/resolve.js', () => ({
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

vi.mock('../mcp/legacy/apps/discovery.js', () => ({
  getAppMeta: vi.fn().mockResolvedValue(null),
}));

vi.mock('../http/iframe-tokens.js', () => ({
  generateIframeToken: vi.fn().mockReturnValue('tok'),
}));

let registerWindowHandlers: (registry: ResourceRegistry, getWindowState: () => any) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    // yaar://windows/{windowId}
    const bareMatch = u.match(/^yaar:\/\/windows\/(.+)$/);
    if (bareMatch) {
      return { kind: 'window', monitorId: '0', windowId: bareMatch[1], sourceUri: u };
    }
    // Bare yaar://windows → window collection (current monitor)
    if (u === 'yaar://windows' || u === 'yaar://windows/') {
      return { kind: 'window', monitorId: '0', windowId: '', sourceUri: u };
    }
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

describe('Monitor read via yaar://windows/', () => {
  it('reads monitor status for current monitor', async () => {
    mockPool.hasMainAgent.mockReturnValue(true);

    const reg = createRegistry();
    // read('yaar://windows/') resolves to monitor-level for the current agent
    const result = await reg.execute('read', 'yaar://windows/');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.monitorId).toBe('0');
    expect(data.hasMainAgent).toBe(true);
    // Should only include windows from monitor 0
    expect(data.windows).toHaveLength(2);
    expect(data.windows[0].title).toBe('Storage');
    expect(data.windows[1].title).toBe('Notes');
  });
});
