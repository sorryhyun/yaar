import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Its own config dir, keyed by pid: partitions run as concurrent processes, and this
// suite and hooks.test.ts would otherwise write the same hooks.json at the same time.
const TEST_CONFIG_DIR = join(tmpdir(), `yaar-hook-scheduler-${process.pid}`);

mock.module('../storage/storage-manager.js', () => ({
  configRead: async (filePath: string) => {
    const { readFile } = await import('fs/promises');
    try {
      return { success: true, content: await readFile(join(TEST_CONFIG_DIR, filePath), 'utf-8') };
    } catch {
      return { success: false, error: 'not found' };
    }
  },
  configWrite: async (filePath: string, content: string) => {
    const { writeFile } = await import('fs/promises');
    await writeFile(join(TEST_CONFIG_DIR, filePath), content, 'utf-8');
    return { success: true, path: filePath };
  },
  getConfigDir: () => TEST_CONFIG_DIR,
}));

interface FiredHook {
  hookId: string;
  monitorId: string;
}

class FakeSession {
  readonly fired: FiredHook[] = [];
  connected = true;
  busy = false;
  monitors = new Set(['0']);

  hasConnections(): boolean {
    return this.connected;
  }
  hasMonitor(monitorId: string): boolean {
    return this.monitors.has(monitorId);
  }
  isMonitorBusy(): boolean {
    return this.busy;
  }
  async runHookAction(hook: { id: string }, monitorId: string): Promise<void> {
    this.fired.push({ hookId: hook.id, monitorId });
  }
}

let sessions: FakeSession[] = [];

mock.module('../session/session-hub.js', () => ({
  getSessionHub: () => ({ all: () => sessions }),
}));

const { addHook, loadHooks, _resetHooksCache } = await import('../features/config/hooks.js');
const { runScheduleTick } = await import('../features/config/hook-scheduler.js');

const HOOKS_FILE = join(TEST_CONFIG_DIR, 'hooks.json');
const CREATED = new Date('2026-08-15T10:00:00.000Z');
const later = (minutes: number) => new Date(CREATED.getTime() + minutes * 60_000);

/** A schedule hook whose `createdAt` is pinned, so `now` in a tick means something. */
async function addScheduleHook(
  action: 'interaction' | 'os_action',
  extras: { schedule: { every?: string; at?: string }; monitorId?: string },
) {
  const hook = await addHook(
    'schedule',
    action === 'interaction'
      ? { type: 'interaction', payload: 'check the build' }
      : { type: 'os_action', payload: { type: 'toast.show', id: 't', message: 'tick' } },
    'Scheduled hook',
    undefined,
    extras,
  );
  const { writeFile } = await import('fs/promises');
  hook.createdAt = CREATED.toISOString();
  await writeFile(HOOKS_FILE, JSON.stringify({ hooks: [hook], idCounter: 1 }, null, 2), 'utf-8');
  _resetHooksCache();
  return hook;
}

const lastRunAt = async () => (await loadHooks())[0]?.lastRunAt;

describe('runScheduleTick', () => {
  beforeEach(async () => {
    _resetHooksCache();
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await rm(HOOKS_FILE, { force: true });
    sessions = [new FakeSession()];
  });

  afterAll(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('does not fire before the first interval has passed', async () => {
    await addScheduleHook('os_action', { schedule: { every: '15m' } });
    await runScheduleTick(later(14));
    expect(sessions[0]!.fired).toEqual([]);
    expect(await lastRunAt()).toBeUndefined();
  });

  it('fires into the connected session and records the slot, not the tick', async () => {
    const hook = await addScheduleHook('os_action', { schedule: { every: '15m' } });
    await runScheduleTick(new Date(later(15).getTime() + 12_000));

    expect(sessions[0]!.fired).toEqual([{ hookId: hook.id, monitorId: '0' }]);
    expect(await lastRunAt()).toBe(later(15).toISOString());
  });

  it('does not fire twice for the same occurrence', async () => {
    await addScheduleHook('os_action', { schedule: { every: '15m' } });
    await runScheduleTick(later(16));
    await runScheduleTick(later(17));
    expect(sessions[0]!.fired).toHaveLength(1);
  });

  it('drops an occurrence nobody is connected for, rather than banking it', async () => {
    await addScheduleHook('os_action', { schedule: { every: '15m' } });
    sessions[0]!.connected = false;

    await runScheduleTick(later(20));
    expect(sessions[0]!.fired).toEqual([]);
    // Marked anyway: the reconnect must not be greeted by every tick it missed.
    expect(await lastRunAt()).toBe(later(15).toISOString());

    sessions[0]!.connected = true;
    await runScheduleTick(later(25));
    expect(sessions[0]!.fired).toEqual([]);
  });

  it('drops an interaction while the monitor is mid-turn', async () => {
    await addScheduleHook('interaction', { schedule: { every: '15m' } });
    sessions[0]!.busy = true;

    await runScheduleTick(later(16));
    expect(sessions[0]!.fired).toEqual([]);
    expect(await lastRunAt()).toBe(later(15).toISOString());
  });

  it('still delivers an os_action while the monitor is mid-turn', async () => {
    // A toast costs nothing and queues behind nothing — only a turn does.
    await addScheduleHook('os_action', { schedule: { every: '15m' } });
    sessions[0]!.busy = true;

    await runScheduleTick(later(16));
    expect(sessions[0]!.fired).toHaveLength(1);
  });

  it('skips a session that does not have the target monitor', async () => {
    await addScheduleHook('os_action', { schedule: { every: '15m' }, monitorId: '3' });
    await runScheduleTick(later(16));
    expect(sessions[0]!.fired).toEqual([]);
  });

  it('delivers to every connected session', async () => {
    const second = new FakeSession();
    sessions.push(second);
    await addScheduleHook('os_action', { schedule: { every: '15m' } });

    await runScheduleTick(later(16));
    expect(sessions[0]!.fired).toHaveLength(1);
    expect(second.fired).toHaveLength(1);
  });

  it('ignores a schedule below the cost floor instead of firing every tick', async () => {
    await addScheduleHook('os_action', { schedule: { every: '1s' } });
    await runScheduleTick(later(60));
    expect(sessions[0]!.fired).toEqual([]);
    expect(await lastRunAt()).toBeUndefined();
  });
});
