/**
 * The launcher watchdog: a server whose launcher was SIGKILLed must notice and shut down,
 * rather than live on as an orphan holding the port.
 *
 * Real processes, not a mocked `process.kill`: what is under test is whether the liveness
 * check reads the OS correctly (procfs on Linux and Android, signal 0 elsewhere), and a
 * mock would only assert what the mock was told.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { watchProcess, watchLauncher } from '../launcher-watchdog.js';

const POLL_MS = 20;

function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

const children: ReturnType<typeof Bun.spawn>[] = [];
function spawnLauncher() {
  const child = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  delete process.env.YAAR_LAUNCHER_PID;
});

describe('watchProcess', () => {
  it('stays quiet while the launcher runs, and fires once when it is SIGKILLed', async () => {
    const launcher = spawnLauncher();
    let calls = 0;
    const stop = watchProcess(launcher.pid, () => calls++, POLL_MS);
    try {
      await Bun.sleep(POLL_MS * 5);
      expect(calls).toBe(0);

      launcher.kill('SIGKILL');
      await launcher.exited;
      await waitFor(() => calls > 0);
      await Bun.sleep(POLL_MS * 5);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  it('fires at once for a launcher that is already gone', async () => {
    const launcher = spawnLauncher();
    launcher.kill('SIGKILL');
    await launcher.exited;
    let calls = 0;
    const stop = watchProcess(launcher.pid, () => calls++, 60_000);
    stop();
    expect(calls).toBe(1);
  });

  it('stops watching when told to', async () => {
    const launcher = spawnLauncher();
    let calls = 0;
    const stop = watchProcess(launcher.pid, () => calls++, POLL_MS);
    stop();
    launcher.kill('SIGKILL');
    await launcher.exited;
    await Bun.sleep(POLL_MS * 5);
    expect(calls).toBe(0);
  });
});

describe('watchLauncher', () => {
  it('watches nothing without YAAR_LAUNCHER_PID', () => {
    expect(watchLauncher(() => {})).toBeNull();
  });

  it('ignores a value that is not a process id', () => {
    for (const value of ['abc', '1', '0', '-5', '12.5']) {
      process.env.YAAR_LAUNCHER_PID = value;
      expect(watchLauncher(() => {})).toBeNull();
    }
  });

  it('takes the variable out of the environment, so spawned agents do not inherit it', async () => {
    const launcher = spawnLauncher();
    process.env.YAAR_LAUNCHER_PID = String(launcher.pid);
    let shutdowns = 0;
    const stop = watchLauncher(() => shutdowns++);
    try {
      expect(stop).not.toBeNull();
      expect(process.env.YAAR_LAUNCHER_PID).toBeUndefined();
      launcher.kill('SIGKILL');
      await launcher.exited;
      await waitFor(() => shutdowns > 0, 5_000);
    } finally {
      stop?.();
    }
  });
});
