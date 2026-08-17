import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';

// Use a temporary config directory for tests. NOTE: the dir is checked into git
// (it also holds the tracked curl_allowed_domains.yaml fixture), so cleanup must
// only remove this test's own hooks.json — never rm the whole dir.
const TEST_CONFIG_DIR = join(import.meta.dirname, '__test-config__');
const HOOKS_FILE = join(TEST_CONFIG_DIR, 'hooks.json');

// Mock storage-manager to point to our test directory
mock.module('../storage/storage-manager.js', () => ({
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
  configStatMtime: async () => null,
  getConfigDir: () => TEST_CONFIG_DIR,
  resolvePath: (path: string) => ({ absolutePath: `/mock-storage/${path}`, readOnly: false }),
  resolvePathAsync: async (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
  ensureStorageDir: async () => {},
  storageRead: async () => ({ success: false }),
  storageWrite: async () => ({ success: true }),
  storageList: async () => ({ success: true, entries: [] }),
  storageDelete: async () => ({ success: true }),
  storageGrep: async () => ({ success: true, matches: [] }),
}));

const {
  loadHooks,
  addHook,
  removeHook,
  getHooksByEvent,
  getToolUseHooks,
  resolveLinkHandler,
  markHookRun,
  _resetHooksCache,
} = await import('../features/config/hooks.js');

describe('hooks storage', () => {
  beforeEach(async () => {
    _resetHooksCache();
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await rm(HOOKS_FILE, { force: true });
  });

  afterEach(async () => {
    await rm(HOOKS_FILE, { force: true });
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
        payload: '<ui:click>app: moltbook</ui:click>',
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

describe('schedule hooks', () => {
  beforeEach(async () => {
    _resetHooksCache();
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await rm(HOOKS_FILE, { force: true });
  });

  afterEach(async () => {
    await rm(HOOKS_FILE, { force: true });
  });

  it('stores the cadence and target monitor', async () => {
    const hook = await addHook(
      'schedule',
      { type: 'interaction', payload: 'Check the build' },
      'Build watch',
      undefined,
      { schedule: { every: '30m' }, monitorId: '1' },
    );

    expect(hook.schedule).toEqual({ every: '30m' });
    expect(hook.monitorId).toBe('1');
    expect(hook.lastRunAt).toBeUndefined();

    const [stored] = await getHooksByEvent('schedule');
    expect(stored?.schedule).toEqual({ every: '30m' });
  });

  it('persists lastRunAt so a restart does not replay the occurrence', async () => {
    const hook = await addHook(
      'schedule',
      { type: 'os_action', payload: { type: 'toast.show', id: 't', message: 'tick' } },
      'Ticker',
      undefined,
      { schedule: { at: '09:00' } },
    );

    const slot = new Date('2026-08-15T09:00:00.000Z');
    await markHookRun(hook.id, slot);

    // Through the cache...
    expect((await loadHooks())[0]?.lastRunAt).toBe(slot.toISOString());

    // ...and through the file, which is the half that survives a restart.
    _resetHooksCache();
    expect((await loadHooks())[0]?.lastRunAt).toBe(slot.toISOString());
  });

  it('ignores a run marked against an unknown hook', async () => {
    await expect(markHookRun('hook-999', new Date())).resolves.toBeUndefined();
  });
});

describe('getToolUseHooks — URI-based matching', () => {
  beforeEach(async () => {
    _resetHooksCache();
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await rm(HOOKS_FILE, { force: true });
  });

  afterEach(async () => {
    await rm(HOOKS_FILE, { force: true });
  });

  it('matches by verb + uri + action', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'Writing...' } },
      'Storage write toast',
      { verb: 'invoke', uri: 'yaar://storage/*', action: 'write' },
    );

    const matched = await getToolUseHooks({
      toolName: 'verbs:invoke',
      verb: 'invoke',
      uri: 'yaar://storage/docs/readme.md',
      action: 'write',
    });
    expect(matched).toHaveLength(1);

    const noMatch = await getToolUseHooks({
      toolName: 'verbs:invoke',
      verb: 'invoke',
      uri: 'yaar://storage/docs/readme.md',
      action: 'delete',
    });
    expect(noMatch).toHaveLength(0);
  });

  it('matches wildcard URI patterns', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'Reading...' } },
      'Storage read',
      { verb: 'read', uri: 'yaar://storage/*' },
    );

    const matched = await getToolUseHooks({
      toolName: 'verbs:read',
      verb: 'read',
      uri: 'yaar://storage/docs/readme.md',
    });
    expect(matched).toHaveLength(1);

    const noMatch = await getToolUseHooks({
      toolName: 'verbs:read',
      verb: 'read',
      uri: 'yaar://apps/my-app',
    });
    expect(noMatch).toHaveLength(0);
  });

  it('matches action array filter', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'Modifying...' } },
      'Write/edit toast',
      { verb: 'invoke', uri: 'yaar://storage/*', action: ['write', 'edit'] },
    );

    const writeMatch = await getToolUseHooks({
      toolName: 'verbs:invoke',
      verb: 'invoke',
      uri: 'yaar://storage/docs/readme.md',
      action: 'write',
    });
    expect(writeMatch).toHaveLength(1);

    const editMatch = await getToolUseHooks({
      toolName: 'verbs:invoke',
      verb: 'invoke',
      uri: 'yaar://storage/docs/readme.md',
      action: 'edit',
    });
    expect(editMatch).toHaveLength(1);
  });

  it('hook with no filter matches everything', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'Tool used!' } },
      'Catch-all',
    );

    const matched = await getToolUseHooks({
      toolName: 'verbs:invoke',
      verb: 'invoke',
      uri: 'yaar://anything',
    });
    expect(matched).toHaveLength(1);
  });

  it('does not match when verb filter present but ctx has no verb', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'Invoke!' } },
      'Invoke only',
      { verb: 'invoke' },
    );

    const noMatch = await getToolUseHooks({ toolName: 'WebSearch' });
    expect(noMatch).toHaveLength(0);
  });

  it('scopes a tool_use hook to one app', async () => {
    await addHook(
      'tool_use',
      { type: 'os_action', payload: { type: 'toast.show', id: 'test', message: 'github!' } },
      'Only the GitHub app',
      { appId: 'github' },
    );

    expect(await getToolUseHooks({ toolName: 'verbs:read', appId: 'github' })).toHaveLength(1);
    expect(await getToolUseHooks({ toolName: 'verbs:read', appId: 'memo' })).toHaveLength(0);
    // A monitor agent's call carries no appId, so a hook naming an app skips it rather
    // than treating "no app" as "any app".
    expect(await getToolUseHooks({ toolName: 'verbs:read' })).toHaveLength(0);
  });
});

describe('link_open hooks', () => {
  beforeEach(async () => {
    _resetHooksCache();
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await rm(HOOKS_FILE, { force: true });
  });

  afterEach(async () => {
    await rm(HOOKS_FILE, { force: true });
  });

  /** The rule a user writes to send a site's links to an app. */
  async function wire(url: string | string[], appId: string, command?: string) {
    return addHook(
      'link_open',
      { type: 'open_in_app', payload: { appId, ...(command ? { command } : {}) } },
      `Open ${Array.isArray(url) ? url.join(', ') : url} in ${appId}`,
      { url },
    );
  }

  it('answers with the app the user wired the site to', async () => {
    await wire('https://github.com/*', 'github');

    expect(await resolveLinkHandler('https://github.com/anthropics/claude-code')).toEqual({
      appId: 'github',
      command: 'openUrl',
      launch: true,
    });
    // The bare origin is the same rule's subject, not a different one.
    expect(await resolveLinkHandler('https://github.com')).toEqual({
      appId: 'github',
      command: 'openUrl',
      launch: true,
    });
  });

  it('answers null for a site with no rule', async () => {
    await wire('https://github.com/*', 'github');

    expect(await resolveLinkHandler('https://example.com/post/1')).toBeNull();
    // A prefix match is on the URL, not the string: a lookalike host is a different site.
    expect(await resolveLinkHandler('https://github.com.evil.test/x')).toBeNull();
  });

  it('takes the command from the hook when it names one', async () => {
    await wire('https://news.example.com/*', 'reader', 'showArticle');

    expect(await resolveLinkHandler('https://news.example.com/a/1')).toEqual({
      appId: 'reader',
      command: 'showArticle',
      launch: true,
    });
  });

  it('reports the launch opt-out, so a heavy app is not cold-started by a link', async () => {
    await addHook(
      'link_open',
      { type: 'open_in_app', payload: { appId: 'lab', launch: false } },
      'Only while it is open',
      { url: 'https://lab.example.com/*' },
    );

    expect(await resolveLinkHandler('https://lab.example.com/x')).toEqual({
      appId: 'lab',
      command: 'openUrl',
      launch: false,
    });
  });

  it('lets an earlier rule win, so a narrow one can sit above a broad one', async () => {
    await wire('https://github.com/anthropics/*', 'claude-watch');
    await wire('https://github.com/*', 'github');

    expect((await resolveLinkHandler('https://github.com/anthropics/x'))?.appId).toBe(
      'claude-watch',
    );
    expect((await resolveLinkHandler('https://github.com/other/x'))?.appId).toBe('github');
  });

  it('ignores a rule that names no site, rather than letting it claim every link', async () => {
    await addHook('link_open', { type: 'open_in_app', payload: { appId: 'github' } }, 'No url');

    expect(await resolveLinkHandler('https://github.com/a/b')).toBeNull();
  });

  it('ignores a disabled rule and a reaction action on this event', async () => {
    const hook = await wire('https://github.com/*', 'github');
    await addHook(
      'link_open',
      { type: 'os_action', payload: { type: 'toast.show', id: 't', message: 'hi' } },
      'A reaction, which link_open never fires',
      { url: 'https://example.com/*' },
    );

    expect(await resolveLinkHandler('https://example.com/x')).toBeNull();

    const hooks = await loadHooks();
    hooks.find((h) => h.id === hook.id)!.enabled = false;
    await writeFile(HOOKS_FILE, JSON.stringify({ hooks, idCounter: hooks.length }, null, 2));
    _resetHooksCache();

    expect(await resolveLinkHandler('https://github.com/a/b')).toBeNull();
  });
});
