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

// Mock session/hub
const mockPool = {
  getStats: vi.fn(),
  hasAgent: vi.fn(),
  interruptAgent: vi.fn(),
  interruptAll: vi.fn(),
};

vi.mock('../agents/session.js', () => ({
  getSessionId: () => 'test-session',
}));

vi.mock('../session/session-hub.js', () => ({
  getSessionHub: () => ({
    get: () => ({
      getPool: () => mockPool,
    }),
    getDefault: () => null,
  }),
}));

let registerAgentsHandlers: (registry: ResourceRegistry) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    if (u === 'yaar://sessions/current/agents' || u === 'yaar://sessions/current/agents/') {
      return { kind: 'session', resource: 'current', subKind: 'agents', sourceUri: u };
    }
    if (u.startsWith('yaar://sessions/current/agents/')) {
      const id = u.replace('yaar://sessions/current/agents/', '');
      return { kind: 'session', resource: 'current', subKind: 'agents', id, sourceUri: u };
    }
    return null;
  });

  mockPool.getStats.mockReturnValue({
    totalAgents: 3,
    idleAgents: 1,
    busyAgents: 2,
    mainAgent: true,
    windowAgents: 1,
    ephemeralAgents: 1,
    mainQueueSize: 0,
    windowQueueSizes: {},
    contextTapeSize: 5,
    timelineSize: 3,
    monitorBudget: {},
  });

  const mod = await import('../mcp/agents/handlers.js');
  registerAgentsHandlers = mod.registerAgentsHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerAgentsHandlers(reg);
  return reg;
}

describe('Agents domain handlers', () => {
  describe('list', () => {
    it('lists agent stats', async () => {
      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://sessions/current/agents');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.totalAgents).toBe(3);
      expect(data.idleAgents).toBe(1);
      expect(data.busyAgents).toBe(2);
    });
  });

  describe('read', () => {
    it('reads agent info', async () => {
      mockPool.hasAgent.mockReturnValue(true);
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://sessions/current/agents/agent-0-123');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.id).toBe('agent-0-123');
      expect(data.exists).toBe(true);
    });

    it('returns error for unknown agent', async () => {
      mockPool.hasAgent.mockReturnValue(false);
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://sessions/current/agents/unknown');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not found');
    });
  });

  describe('invoke', () => {
    it('interrupts a specific agent', async () => {
      mockPool.interruptAgent.mockResolvedValue(true);
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/agents/agent-0-123', {
        action: 'interrupt',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Interrupted');
      expect(mockPool.interruptAgent).toHaveBeenCalledWith('agent-0-123');
    });

    it('returns error if agent not found for interrupt', async () => {
      mockPool.interruptAgent.mockResolvedValue(false);
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/agents/unknown', {
        action: 'interrupt',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error for unknown action', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/agents/agent-0-123', {
        action: 'unknown',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error without action', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/agents/agent-0-123', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('describe', () => {
    it('returns description for agents collection', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://sessions/current/agents');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.verbs).toContain('list');
    });

    it('returns description for specific agent', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://sessions/current/agents/agent-0-123');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.verbs).toContain('read');
      expect(data.verbs).toContain('invoke');
    });
  });
});
