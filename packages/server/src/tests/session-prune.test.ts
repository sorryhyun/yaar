import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneEmptySessions } from '../logging/prune.js';
import type { SessionMetadata } from '../logging/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-prune-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Lay down a session directory in the shape `createSession()` creates. */
async function makeSession(
  id: string,
  opts: {
    messages?: string;
    agents?: Record<string, string>;
    metadata?: Partial<SessionMetadata> | null;
    extraFile?: string;
  } = {},
): Promise<string> {
  const dir = join(root, id);
  await mkdir(join(dir, 'agents'), { recursive: true });
  if (opts.metadata !== null) {
    const metadata: SessionMetadata = {
      createdAt: '2026-01-01T00:00:00.000Z',
      provider: 'claude',
      lastActivity: '2026-01-01T00:00:00.000Z',
      agents: {},
      ...opts.metadata,
    };
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  }
  await writeFile(join(dir, 'messages.jsonl'), opts.messages ?? '');
  for (const [name, body] of Object.entries(opts.agents ?? { 'default.jsonl': '' })) {
    await writeFile(join(dir, 'agents', name), body);
  }
  if (opts.extraFile) await writeFile(join(dir, opts.extraFile), 'x');
  return dir;
}

/**
 * Prune as if the grace window had already elapsed — the fixtures were written milliseconds
 * ago. The clock is pushed forward rather than the window set to zero: `mtimeMs` carries
 * sub-millisecond precision that `Date.now()` truncates away, so a file written *before* the
 * call still compares as newer than "now" often enough to fail under load.
 */
function prune(options: Parameters<typeof pruneEmptySessions>[0] = {}) {
  return pruneEmptySessions({ dir: root, graceMs: 0, now: Date.now() + 1_000, ...options });
}

describe('pruneEmptySessions', () => {
  it('removes a session that recorded nothing', async () => {
    await makeSession('empty-1');
    await makeSession('empty-2');

    expect((await prune()).sort()).toEqual(['empty-1', 'empty-2']);
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a directory that holds nothing at all', async () => {
    await mkdir(join(root, 'aborted'), { recursive: true });

    expect(await prune()).toEqual(['aborted']);
  });

  it('keeps an empty directory inside the grace window', async () => {
    await mkdir(join(root, 'being-created'), { recursive: true });

    expect(await pruneEmptySessions({ dir: root, graceMs: 60_000 })).toEqual([]);
  });

  it('keeps a session with logged messages', async () => {
    await makeSession('used', { messages: '{"type":"user"}\n' });

    expect(await prune()).toEqual([]);
    expect(await readdir(root)).toEqual(['used']);
  });

  it('keeps a session whose only content is in a per-agent log', async () => {
    await makeSession('agent-only', {
      agents: { 'default.jsonl': '', 'monitor-0.jsonl': '{"type":"assistant"}\n' },
    });

    expect(await prune()).toEqual([]);
  });

  it('keeps a session holding an unexpected file', async () => {
    await makeSession('extra', { extraFile: 'screenshot.png' });

    expect(await prune()).toEqual([]);
  });

  it('keeps a session with no (or unparseable) metadata', async () => {
    await makeSession('no-metadata', { metadata: null });
    const broken = await makeSession('broken-metadata');
    await writeFile(join(broken, 'metadata.json'), '{ not json');

    expect(await prune()).toEqual([]);
  });

  it('keeps a session owned by a live process, prunes one owned by a dead pid', async () => {
    await makeSession('live', { metadata: { pid: process.pid } });
    // A pid that cannot exist — `process.kill` rejects it as out of range, same as gone.
    await makeSession('dead', { metadata: { pid: 2 ** 31 - 1 } });

    expect(await prune()).toEqual(['dead']);
    expect(await readdir(root)).toEqual(['live']);
  });

  it('keeps sessions inside the grace window', async () => {
    await makeSession('fresh');

    expect(await pruneEmptySessions({ dir: root, graceMs: 60_000 })).toEqual([]);
  });

  it('never touches an explicitly kept session', async () => {
    await makeSession('current');
    await makeSession('previous');

    expect(await prune({ keep: ['current'] })).toEqual(['previous']);
  });

  it('is a no-op when the session directory does not exist', async () => {
    expect(await pruneEmptySessions({ dir: join(root, 'nope'), graceMs: 0 })).toEqual([]);
  });

  it('ignores stray files beside the session directories', async () => {
    await writeFile(join(root, 'README.md'), 'not a session');
    await makeSession('empty');

    expect(await prune()).toEqual(['empty']);
    expect(await readdir(root)).toEqual(['README.md']);
  });
});
