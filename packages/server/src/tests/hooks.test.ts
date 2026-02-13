import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { loadHooks, addHook, removeHook, getHooksByEvent } from '../mcp/system/hooks.js';

// Use a temporary config directory for tests
const TEST_CONFIG_DIR = join(import.meta.dirname, '__test-config__');

// Mock getConfigDir to point to our test directory
vi.mock('../../src/storage/storage-manager.js', async () => {
  return {
    configRead: async (filePath: string) => {
      const { readFile } = await import('fs/promises');
      const { join: pathJoin, normalize, relative } = await import('path');
      const normalizedPath = normalize(pathJoin(TEST_CONFIG_DIR, filePath));
      const rel = relative(TEST_CONFIG_DIR, normalizedPath);
      if (rel.startsWith('..')) return { success: false, error: 'traversal' };
      try {
        const content = await readFile(normalizedPath, 'utf-8');
        return { success: true, content };
      } catch {
        return { success: false, error: 'not found' };
      }
    },
    configWrite: async (filePath: string, content: string) => {
      const { writeFile: wf, mkdir: mkd } = await import('fs/promises');
      const { join: pathJoin, normalize, relative, dirname } = await import('path');
      const normalizedPath = normalize(pathJoin(TEST_CONFIG_DIR, filePath));
      const rel = relative(TEST_CONFIG_DIR, normalizedPath);
      if (rel.startsWith('..')) return { success: false, path: filePath, error: 'traversal' };
      await mkd(dirname(normalizedPath), { recursive: true });
      await wf(normalizedPath, content, 'utf-8');
      return { success: true, path: filePath };
    },
    getConfigDir: () => TEST_CONFIG_DIR,
  };
});

describe('hooks storage', () => {
  beforeEach(async () => {
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('returns empty array when no hooks file exists', async () => {
    const hooks = await loadHooks();
    expect(hooks).toEqual([]);
  });

  it('adds a hook and reads it back', async () => {
    const hook = await addHook(
      'launch',
      {
        type: 'interaction',
        payload: '<user_interaction:click>app: moltbook</user_interaction:click>',
      },
      'Open Moltbook on startup',
    );

    expect(hook.id).toBe('hook-1');
    expect(hook.event).toBe('launch');
    expect(hook.enabled).toBe(true);

    const hooks = await loadHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.label).toBe('Open Moltbook on startup');
  });

  it('increments ID counter across adds', async () => {
    const h1 = await addHook('launch', { type: 'interaction', payload: 'a' }, 'Hook A');
    const h2 = await addHook('launch', { type: 'interaction', payload: 'b' }, 'Hook B');

    expect(h1.id).toBe('hook-1');
    expect(h2.id).toBe('hook-2');

    const hooks = await loadHooks();
    expect(hooks).toHaveLength(2);
  });

  it('removes a hook by ID', async () => {
    await addHook('launch', { type: 'interaction', payload: 'a' }, 'Hook A');
    await addHook('launch', { type: 'interaction', payload: 'b' }, 'Hook B');

    const removed = await removeHook('hook-1');
    expect(removed).toBe(true);

    const hooks = await loadHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.id).toBe('hook-2');
  });

  it('returns false when removing non-existent hook', async () => {
    const removed = await removeHook('hook-999');
    expect(removed).toBe(false);
  });

  it('filters hooks by event type', async () => {
    await addHook('launch', { type: 'interaction', payload: 'a' }, 'Launch Hook');

    const launchHooks = await getHooksByEvent('launch');
    expect(launchHooks).toHaveLength(1);

    const otherHooks = await getHooksByEvent('other');
    expect(otherHooks).toHaveLength(0);
  });

  it('filters out disabled hooks', async () => {
    await addHook('launch', { type: 'interaction', payload: 'a' }, 'Hook A');

    // Manually disable the hook by writing the file directly
    const hooks = await loadHooks();
    hooks[0]!.enabled = false;
    await writeFile(
      join(TEST_CONFIG_DIR, 'hooks.json'),
      JSON.stringify({ hooks, idCounter: 1 }, null, 2),
      'utf-8',
    );

    const enabled = await getHooksByEvent('launch');
    expect(enabled).toHaveLength(0);
  });

  it('handles corrupted hooks file gracefully', async () => {
    await writeFile(join(TEST_CONFIG_DIR, 'hooks.json'), 'not json', 'utf-8');

    const hooks = await loadHooks();
    expect(hooks).toEqual([]);
  });
});
