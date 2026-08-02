/**
 * What a launch restores from.
 *
 * The regression these guard against was silent: boot minted its own (empty) session log
 * *before* resolving "the most recent previous session", so the restore always read the
 * file it had just created and every relaunch came up with a bare desktop. Nothing in the
 * suite noticed, because the choice lived inline in `initializeSubsystems()`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findRestorableSession } from '../logging/restore-source.js';
import { createSession } from '../logging/session-logger.js';
import type { SessionMetadata } from '../logging/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-restore-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A session directory whose `createdAt` (and therefore sort order) we control. */
async function seedSession(
  id: string,
  createdAt: string,
  messages: object[],
  metadata: Partial<SessionMetadata> = {},
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, 'agents'), { recursive: true });
  const full: SessionMetadata = {
    createdAt,
    provider: 'claude',
    lastActivity: createdAt,
    agents: {},
    ...metadata,
  };
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(full, null, 2));
  await writeFile(
    join(dir, 'messages.jsonl'),
    messages.map((m) => JSON.stringify(m) + '\n').join(''),
  );
}

const userMessage = (content: string) => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  agentId: 'monitor-0',
  parentAgentId: null,
  content,
});

describe('findRestorableSession', () => {
  it('returns the newest session that recorded something', async () => {
    await seedSession('older', '2026-01-01T00:00:00.000Z', [userMessage('older')]);
    await seedSession('newer', '2026-01-02T00:00:00.000Z', [userMessage('newer')]);

    const restorable = await findRestorableSession(root);
    expect(restorable?.session.sessionId).toBe('newer');
    expect(restorable?.messages).toHaveLength(1);
  });

  it('skips newer empty logs rather than restoring nothing from them', async () => {
    await seedSession('real', '2026-01-01T00:00:00.000Z', [userMessage('hello')]);
    await seedSession('empty-relaunch', '2026-01-02T00:00:00.000Z', []);
    await seedSession('another-empty', '2026-01-03T00:00:00.000Z', []);

    const restorable = await findRestorableSession(root);
    expect(restorable?.session.sessionId).toBe('real');
  });

  it("carries the chosen session's thread ids, not the newest session's", async () => {
    await seedSession('real', '2026-01-01T00:00:00.000Z', [userMessage('hello')], {
      threadIds: { 'monitor-0': 'thread-abc' },
    });
    await seedSession('empty-relaunch', '2026-01-02T00:00:00.000Z', []);

    const restorable = await findRestorableSession(root);
    expect(restorable?.session.metadata.threadIds).toEqual({ 'monitor-0': 'thread-abc' });
  });

  it('returns null when nothing has been recorded', async () => {
    await seedSession('empty', '2026-01-01T00:00:00.000Z', []);

    expect(await findRestorableSession(root)).toBeNull();
  });

  it('returns null on a fresh checkout', async () => {
    expect(await findRestorableSession(join(root, 'never-created'))).toBeNull();
  });

  it('is unaffected by the log the current launch mints', async () => {
    await seedSession('real', '2026-01-01T00:00:00.000Z', [userMessage('hello')]);

    // What boot does next: mint this launch's own (empty) directory. It sorts first —
    // and used to be what the restore read.
    const created = await createSession('pending', root);
    expect((await readdir(root)).sort()).toEqual(['real', created.sessionId].sort());

    const restorable = await findRestorableSession(root);
    expect(restorable?.session.sessionId).toBe('real');
  });
});
