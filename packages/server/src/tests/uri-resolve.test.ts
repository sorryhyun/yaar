/**
 * Integration test for URI resolution — the glue between verb tools and handlers.
 *
 * Tests that resolveUri correctly maps all key yaar:// patterns to their
 * expected ResolvedUri kinds. This replaces 8 over-mocked handler tests
 * with a single test that validates the actual routing layer.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock server dependencies that resolveUri imports
vi.mock('../storage/storage-manager.js', () => ({
  resolvePath: (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
}));
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/mock-root' }));
vi.mock('../agents/session.js', () => ({
  getMonitorId: () => '0',
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
