/**
 * Integration test for URI resolution — the glue between verb tools and handlers.
 *
 * Tests that resolveUri correctly maps all key yaar:// patterns to their
 * expected ResolvedUri kinds. This replaces 8 over-mocked handler tests
 * with a single test that validates the actual routing layer.
 */
import { mock, describe, it, expect } from 'bun:test';

// Mock server dependencies that resolveUri imports
mock.module('../storage/storage-manager.js', () => ({
  resolvePath: (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
  resolvePathAsync: async (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
  getConfigDir: () => '/tmp/mock-config',
  ensureStorageDir: async () => {},
  configRead: mock(async () => ({ success: false })),
  configWrite: mock(async () => ({ success: true })),
  storageRead: mock(async () => ({ success: false })),
  storageWrite: mock(async () => ({ success: true })),
  storageList: mock(async () => ({ success: true, entries: [] })),
  storageDelete: mock(async () => ({ success: true })),
  storageGrep: mock(async () => ({ success: true, matches: [] })),
}));
mock.module('../config.js', () => ({
  getEnvInt: (key: string, def: number) => def,
  IS_BUNDLED_EXE: false,
  PROJECT_ROOT: '/mock-root',
  getStorageDir: () => '/tmp/mock-storage',
  STORAGE_DIR: '/tmp/mock-storage',
  getConfigDir: () => '/tmp/mock-config',
  getFrontendDist: () => '/tmp/mock-dist',
  FRONTEND_DIST: '/tmp/mock-dist',
  MIME_TYPES: {},
  MAX_UPLOAD_SIZE: 50 * 1024 * 1024,
  getPort: () => 8000,
  setPort: () => {},
  PORT: 8000,
  IS_REMOTE: false,
  MARKET_URL: 'https://yaarmarket.vercel.app',
  MONITOR_MAX_CONCURRENT: 2,
  MONITOR_MAX_ACTIONS_PER_MIN: 30,
  MONITOR_MAX_OUTPUT_PER_MIN: 50000,
  resolveClaudeBinPath: () => null,
  getClaudeSpawnArgs: () => [],
  getCodexSpawnArgs: () => [],
  getCodexBin: () => 'codex',
  CODEX_WS_PORT: 4510,
  getCodexWsPort: () => 4510,
  getCodexAppServerArgs: () => [],
}));
mock.module('../agents/session.js', () => ({
  AgentSession: class {},
  getAgentId: () => undefined,
  getCurrentConnectionId: () => undefined,
  getSessionId: () => undefined,
  getMonitorId: () => '0',
  getWindowId: () => undefined,
  runWithAgentId: (_id: string, fn: () => unknown) => fn(),
  runWithAgentContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

const { resolveUri } = await import('../handlers/uri-resolve.js');

describe('resolveUri', () => {
  it('resolves root URI', () => {
    const r = resolveUri('yaar://');
    expect(r).toEqual({ kind: 'root', sourceUri: 'yaar://' });
  });

  it('resolves config URIs', () => {
    const settings = resolveUri('yaar://config/settings');
    expect(settings?.kind).toBe('config');
    if (settings?.kind === 'config') {
      expect(settings.section).toBe('settings');
    }

    const hooks = resolveUri('yaar://config/hooks');
    expect(hooks?.kind).toBe('config');

    const appConfig = resolveUri('yaar://config/app/github');
    expect(appConfig?.kind).toBe('config');
    if (appConfig?.kind === 'config') {
      expect(appConfig.section).toBe('app');
      expect(appConfig.id).toBe('github');
    }
  });

  it('resolves browser URIs', () => {
    const browsers = resolveUri('yaar://browser/sessions');
    expect(browsers?.kind).toBe('browser');

    const session = resolveUri('yaar://browser/sessions/abc');
    expect(session?.kind).toBe('browser');
    if (session?.kind === 'browser') {
      expect(session.resource).toBe('sessions');
      expect(session.subResource).toBe('abc');
    }
  });

  it('resolves session URIs', () => {
    const agents = resolveUri('yaar://sessions/current/agents');
    expect(agents?.kind).toBe('session');
    if (agents?.kind === 'session') {
      expect(agents.resource).toBe('current');
      expect(agents.subKind).toBe('agents');
    }

    const specific = resolveUri('yaar://sessions/current/agents/agent-0-123');
    expect(specific?.kind).toBe('session');
    if (specific?.kind === 'session') {
      expect(specific.id).toBe('agent-0-123');
    }
  });

  it('resolves window URIs', () => {
    const win = resolveUri('yaar://monitors/0/my-window');
    expect(win?.kind).toBe('window');
    if (win?.kind === 'window') {
      expect(win.monitorId).toBe('0');
      expect(win.windowId).toBe('my-window');
    }

    // Bare window URI (no monitor)
    const bare = resolveUri('yaar://windows/my-window');
    expect(bare?.kind).toBe('window');
    if (bare?.kind === 'window') {
      expect(bare.windowId).toBe('my-window');
    }
  });

  it('resolves storage URIs', () => {
    const file = resolveUri('yaar://storage/notes/hello.md');
    expect(file?.kind).toBe('storage');
    if (file?.kind === 'storage') {
      expect(file.absolutePath).toContain('notes/hello.md');
    }
  });

  it('resolves app URIs to root kind', () => {
    const apps = resolveUri('yaar://apps');
    expect(apps?.kind).toBe('root');
  });

  it('resolves bare authority URIs', () => {
    for (const authority of ['apps', 'storage', 'config', 'browser', 'sessions', 'skills']) {
      const r = resolveUri(`yaar://${authority}`);
      expect(r, `yaar://${authority} should resolve`).not.toBeNull();
    }
  });

  it('returns null for invalid URIs', () => {
    expect(resolveUri('https://example.com')).toBeNull();
    expect(resolveUri('not-a-uri')).toBeNull();
  });
});
