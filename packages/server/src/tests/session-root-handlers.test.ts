import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import type { VerbResult } from '../handlers/uri-registry.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../handlers/uri-resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

// Mock storage
vi.mock('../storage/storage-manager.js', () => ({
  configRead: vi.fn().mockResolvedValue({ success: true, content: '' }),
  configWrite: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock session/hub
const mockPool = {
  getStats: vi.fn().mockReturnValue({
    totalAgents: 2,
    idleAgents: 1,
    busyAgents: 1,
    mainAgent: true,
    windowAgents: 1,
    ephemeralAgents: 0,
    mainQueueSize: 0,
    windowQueueSizes: {},
    contextTapeSize: 5,
    timelineSize: 3,
    monitorBudget: {},
  }),
};

const mockWindowState = {
  listWindows: vi.fn().mockReturnValue([
    { id: '0/win-1', title: 'Window 1' },
    { id: '0/win-2', title: 'Window 2' },
  ]),
};

vi.mock('../agents/session.js', () => ({
  getSessionId: () => 'test-session',
}));

vi.mock('../session/session-hub.js', () => ({
  getSessionHub: () => ({
    get: () => ({
      sessionId: 'test-session',
      getPool: () => mockPool,
      windowState: mockWindowState,
    }),
    getDefault: () => null,
  }),
}));

// Mock browser pool
vi.mock('../lib/browser/index.js', () => ({
  getBrowserPool: () => ({
    getAllSessions: () => new Map(),
  }),
}));

let registerSessionHandlers: (registry: ResourceRegistry) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    if (u === 'yaar://') {
      return { kind: 'root', sourceUri: u };
    }
    if (u === 'yaar://sessions/current') {
      return { kind: 'session', resource: 'current', sourceUri: u };
    }
    return null;
  });

  const mod = await import('../handlers/session.js');
  registerSessionHandlers = mod.registerSessionHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerSessionHandlers(reg);
  return reg;
}

describe('Session root handler', () => {
  describe('read yaar://', () => {
    it('returns session overview', async () => {
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.sessionId).toBe('test-session');
      expect(data.agents).toBeDefined();
      expect(data.agents.total).toBe(2);
      expect(data.windows).toBe(2);
      expect(data.browsers).toBe(0);
    });
  });

  describe('list yaar://', () => {
    it('lists all namespaces', async () => {
      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.namespaces).toContain('yaar://apps/');
      expect(data.namespaces).toContain('yaar://browser/');
      expect(data.namespaces).toContain('yaar://sessions/');
      expect(data.namespaces.length).toBe(7);
    });
  });

  describe('describe yaar://', () => {
    it('returns description', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.verbs).toContain('read');
      expect(data.verbs).toContain('list');
    });
  });
});
