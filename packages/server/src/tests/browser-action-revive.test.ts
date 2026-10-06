/**
 * A browser action addressed at a suspended tab brings it back instead of refusing.
 *
 * An idle sweep or a server restart leaves a tab as a record with no socket. An app
 * that opened that tab before the sweep still holds its id, and "No browser with ID"
 * made it read a good tab as gone — a reader app reading its cookie jar through a swept
 * tab decided the user was logged out, and its login wait could never succeed.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionForAction } from '../features/browser/actions.js';
import { BrowserSessionStore } from '../lib/browser/session-store.js';
import type { BrowserProvider } from '../lib/browser/index.js';

/** A provider with one suspended record, `main`, and no live sessions until revived. */
function suspendedPool() {
  const revived: string[] = [];
  const session = { id: 'main' };
  const live = new Map<string, unknown>();
  const pool = {
    getSession: (id: string) => live.get(id),
    reviveSession: async (id: string) => {
      revived.push(id);
      if (id !== 'main') return null;
      live.set(id, session);
      return session;
    },
  } as unknown as BrowserProvider;
  return { pool, revived, session };
}

describe('sessionForAction', () => {
  it('revives a suspended tab for an action that addresses it', async () => {
    const { pool, revived, session } = suspendedPool();
    expect(await sessionForAction(pool, 'get_cookies', 'main')).toBe(session as never);
    expect(revived).toEqual(['main']);
  });

  it('answers with the live session without reviving anything', async () => {
    const { pool, revived, session } = suspendedPool();
    await sessionForAction(pool, 'navigate', 'main');
    expect(await sessionForAction(pool, 'screenshot', 'main')).toBe(session as never);
    expect(revived).toEqual(['main']);
  });

  it('leaves an id with no record unresolved', async () => {
    const { pool } = suspendedPool();
    expect(await sessionForAction(pool, 'get_cookies', 'never-opened')).toBeUndefined();
  });

  it('does not revive for actions that make, list, close or reconfigure tabs', async () => {
    const { pool, revived } = suspendedPool();
    for (const action of [
      'create',
      'open',
      'list_tabs',
      'close_tab',
      'set_request_blocking',
      'set_init_script',
      'not-an-action',
    ]) {
      expect(await sessionForAction(pool, action, 'main')).toBeUndefined();
    }
    expect(revived).toEqual([]);
  });
});

describe('BrowserSessionStore.load', () => {
  it('makes a concurrent caller wait for the read instead of seeing an empty store', async () => {
    // The revive that follows a new tab's first write calls load() while that write's
    // load() is still reading. A flag set before the read finished answered it with
    // nothing, and the revive reported a recorded session as gone.
    const dir = await mkdtemp(join(tmpdir(), 'yaar-store-test-'));
    const prev = process.env.YAAR_BROWSER_STATE_DIR;
    process.env.YAAR_BROWSER_STATE_DIR = dir;
    try {
      const now = Date.now();
      await writeFile(
        join(dir, 'sessions.json'),
        JSON.stringify([
          {
            id: 'main',
            url: 'about:blank',
            title: '',
            mobile: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'post',
            url: 'https://old.test/',
            title: '',
            mobile: true,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      );
      const store = new BrowserSessionStore();
      const first = store.load();
      // Changed while the file is being read: newer than what the file says.
      store.remember('post', { url: 'https://new.test/' });
      await store.load();
      expect(store.get('main')).toBeDefined();
      expect(store.get('post')?.url).toBe('https://new.test/');
      await first;
    } finally {
      if (prev === undefined) delete process.env.YAAR_BROWSER_STATE_DIR;
      else process.env.YAAR_BROWSER_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
