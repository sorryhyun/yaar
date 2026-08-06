/**
 * Settings: the provider switch, and the door count.
 *
 * `PATCH /api/settings` and the `yaar://config/settings` verb used to be two
 * implementations of one act — with different change detection (the verb compared the
 * persisted setting, the route `WarmPool.getPreferredProvider()`), and with only the
 * verb validating input or telling the desktop what moved. `applySettings` is now the
 * one implementation and both doors call it, so these tests are the whole surface.
 */
import { describe, it, expect, afterEach } from 'bun:test';

import { applySettings } from '../features/config/settings.js';
import { readSettings } from '../storage/settings.js';
import { getSessionHub } from '../session/session-hub.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'ses-provider-switch' as SessionId;

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

/** A session whose pool reports `busyAgents`, which is all the switch asks it. */
function sessionWithBusyAgents(busyAgents: number) {
  const session = getSessionHub().getOrCreate(SESSION, {});
  (session as unknown as { getPool: () => unknown }).getPool = () => ({
    getStats: () => ({ busyAgents }),
  });
  return session;
}

describe('applySettings', () => {
  it('refuses an invalid patch instead of persisting it', async () => {
    const before = await readSettings();

    const result = await applySettings({ theme: 'neon' });

    expect(result.ok).toBe(false);
    expect((await readSettings()).theme).toBe(before.theme);
  });

  it('refuses a provider switch while a session has a turn in flight', async () => {
    sessionWithBusyAgents(1);
    const before = await readSettings();
    const next = before.provider === 'codex' ? 'claude' : 'codex';

    const result = await applySettings({ provider: next });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('turn in flight');

    // Refused *before* the write: settings saying `codex` over a pool still running
    // `claude` is the same desync the refusal exists to prevent, by another route.
    expect((await readSettings()).provider).toBe(before.provider);
  });

  it('lets an unrelated setting through while a turn is in flight', async () => {
    // The refusal is scoped to the provider — a busy agent has no opinion on the
    // wallpaper, and a switch that blocked every setting would be a worse bug.
    sessionWithBusyAgents(1);

    const result = await applySettings({ wallpaper: 'test-wallpaper' });

    expect(result.ok).toBe(true);
    expect((await readSettings()).wallpaper).toBe('test-wallpaper');
  });
});
