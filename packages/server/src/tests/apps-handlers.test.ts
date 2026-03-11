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

// Mock discovery
const mockListApps = vi.fn();
const mockLoadAppSkill = vi.fn();
vi.mock('../features/apps/discovery.js', () => ({
  listApps: (...args: unknown[]) => mockListApps(...args),
  loadAppSkill: (...args: unknown[]) => mockLoadAppSkill(...args),
  getAppMeta: () => null,
}));

// Mock action emitter
const mockEmitAction = vi.fn();
vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: (...args: unknown[]) => mockEmitAction(...args),
  },
}));

// Mock config/shortcuts/fs
vi.mock('../../config.js', () => ({ PROJECT_ROOT: '/mock-root' }));
vi.mock('../../storage/storage-manager.js', () => ({
  getConfigDir: () => '/mock-config',
  resolvePath: vi.fn(),
  configRead: vi.fn(),
  configWrite: vi.fn(),
}));
vi.mock('../../storage/shortcuts.js', () => ({
  ensureAppShortcut: vi.fn(),
  removeAppShortcut: vi.fn().mockResolvedValue(false),
}));

let registerAppsHandlers: (registry: ResourceRegistry) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    if (u === 'yaar://apps')
      return { kind: 'app-static', absolutePath: '/mock', sourceUri: u, apiPath: '/api/apps' };
    const match = u.match(/^yaar:\/\/apps\/([^/]+)/);
    if (match)
      return {
        kind: 'app-static',
        absolutePath: '/mock',
        appId: match[1],
        sourceUri: u,
        apiPath: `/api/apps/${match[1]}`,
      };
    return null;
  });

  const mod = await import('../handlers/apps.js');
  registerAppsHandlers = mod.registerAppsHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerAppsHandlers(reg);
  return reg;
}

describe('Apps domain handlers', () => {
  describe('list', () => {
    it('lists apps', async () => {
      mockListApps.mockResolvedValue([
        { id: 'notes', name: 'Notes', hasSkill: true, hasConfig: false, createShortcut: true },
        { id: 'calc', name: 'Calculator', hasSkill: false, hasConfig: false, createShortcut: true },
      ]);

      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://apps');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Notes');
      expect(text(result)).toContain('Calculator');
    });

    it('handles empty apps', async () => {
      mockListApps.mockResolvedValue([]);

      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://apps');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('No apps');
    });
  });

  describe('read (load skill)', () => {
    it('loads app skill', async () => {
      mockLoadAppSkill.mockResolvedValue('# Notes App\nCreate and manage notes.');
      mockListApps.mockResolvedValue([]);

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://apps/notes');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Notes App');
    });

    it('returns error for missing skill', async () => {
      mockLoadAppSkill.mockResolvedValue(null);

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://apps/unknown');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('No SKILL.md');
    });
  });

  describe('invoke (set_badge)', () => {
    it('sets badge count', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://apps/notes', {
        action: 'set_badge',
        count: 5,
      });
      expect(result.isError).toBeFalsy();
      expect(mockEmitAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'app.badge', appId: 'notes', count: 5 }),
      );
    });
  });

  describe('describe', () => {
    it('describes apps root', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://apps');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.verbs).toContain('list');
      expect(body.verbs).not.toContain('invoke');
    });

    it('describes specific app', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://apps/notes');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.verbs).toContain('read');
      expect(body.verbs).toContain('invoke');
      expect(body.verbs).toContain('delete');
    });
  });
});
