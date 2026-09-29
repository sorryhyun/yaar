/**
 * What a launch restores from.
 *
 * The regression these guard against was silent: boot minted its own (empty) session log
 * *before* resolving "the most recent previous session", so the restore always read the
 * file it had just created and every relaunch came up with a bare desktop. Nothing in the
 * suite noticed, because the choice lived inline in `initializeSubsystems()`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readdir, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findRestorableSession, selectCarryOverEntries } from '../logging/restore-source.js';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { getWindowRestoreActions } from '../logging/window-restore.js';
import { getContextRestoreMessages } from '../logging/context-restore.js';
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

/**
 * A restart restores the previous log into memory; these check that the new log records
 * it too. It used to start blank, so it read as a reset — and the restart after it
 * restored from that blank-but-for-new-activity log and really did lose everything.
 */
describe('carry-over into the next launch', () => {
  const windowCreate = (windowId: string, title: string) => ({
    type: 'action',
    timestamp: '2026-01-01T00:00:01.000Z',
    agentId: 'monitor-0',
    parentAgentId: null,
    action: {
      type: 'window.create',
      windowId,
      title,
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: title },
    },
  });
  const assistantMessage = (content: string) => ({ ...userMessage(content), type: 'assistant' });

  /** What `lifecycle.ts` does at boot: restore, mint this launch's log, seed it. */
  async function relaunch(): Promise<{ logger: SessionLogger; sessionId: string }> {
    const restorable = await findRestorableSession(root);
    const created = await createSession('claude', root);
    const logger = new SessionLogger(created);
    if (restorable) {
      logger.carryOver(
        restorable.session.sessionId,
        selectCarryOverEntries(restorable.messages, getWindowRestoreActions(restorable.messages)),
        restorable.session.metadata.threadIds,
      );
    }
    return { logger, sessionId: created.sessionId };
  }

  beforeEach(async () => {
    await seedSession(
      'first',
      '2026-01-01T00:00:00.000Z',
      [
        userMessage('remember the number 7'),
        assistantMessage('noted: 7'),
        windowCreate('0/notes', 'Notes'),
        windowCreate('0/scratch', 'Scratch'),
        {
          type: 'interaction',
          timestamp: '2026-01-01T00:00:02.000Z',
          agentId: null,
          parentAgentId: null,
          interaction: 'close:0/scratch',
        },
      ],
      { threadIds: { 'monitor-0': 'thread-abc' } },
    );
  });

  it('a relaunch that records anything carries the restored state with it', async () => {
    const { logger, sessionId } = await relaunch();
    logger.logUserMessage('what was the number?', 'monitor-0');
    await logger.dispose();

    // The restart after that one restores from the second log — and gets everything.
    const restorable = await findRestorableSession(root);
    expect(restorable?.session.sessionId).toBe(sessionId);
    expect(restorable?.session.metadata.restoredFrom).toBe('first');
    expect(restorable?.session.metadata.threadIds).toEqual({ 'monitor-0': 'thread-abc' });
    expect(getContextRestoreMessages(restorable!.messages).map((m) => m.content)).toEqual([
      'remember the number 7',
      'noted: 7',
      'what was the number?',
    ]);
    expect(
      getWindowRestoreActions(restorable!.messages).map(
        (a) => (a as { windowId?: string }).windowId,
      ),
    ).toEqual(['0/notes']);
  });

  it('survives a chain of restarts', async () => {
    for (const note of ['second', 'third']) {
      const { logger, sessionId } = await relaunch();
      logger.logUserMessage(note, 'monitor-0');
      await logger.dispose();
      // Session ids have one-second resolution; two relaunches in a test do not.
      await rename(join(root, sessionId), join(root, note));
    }

    const restorable = await findRestorableSession(root);
    expect(getContextRestoreMessages(restorable!.messages).map((m) => m.content)).toEqual([
      'remember the number 7',
      'noted: 7',
      'second',
      'third',
    ]);
    // The snapshot is re-reduced each hop, not appended to: one window, one create.
    expect(restorable!.messages.filter((m) => m.type === 'action')).toHaveLength(1);
  });

  it('a relaunch nobody used stays prunable and restores nothing of its own', async () => {
    const { logger, sessionId } = await relaunch();
    await logger.dispose();

    // Exactly the shape `pruneEmptySessions()` deletes: nothing in the log itself.
    expect(await Bun.file(join(root, sessionId, 'messages.jsonl')).text()).toBe('');
    expect(await findRestorableSession(root).then((r) => r?.session.sessionId)).toBe('first');
  });

  it('a monitor reset drops the carried thread id', async () => {
    const { logger } = await relaunch();
    logger.clearThreadId('monitor-0');
    logger.logUserMessage('start over', 'monitor-0');
    await logger.dispose();

    const restorable = await findRestorableSession(root);
    expect(restorable?.session.metadata.threadIds ?? {}).toEqual({});
  });
});
