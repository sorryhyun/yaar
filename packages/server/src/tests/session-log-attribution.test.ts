/**
 * Which desktop each session-log entry belongs to.
 *
 * A reader (the session-logs app) groups a transcript by monitor. Before these fields it
 * had to parse the monitor back out of `agentId` strings, and for the bulk of a busy
 * session it could not: iframe verb calls and user interactions carry no agent at all,
 * and a monitor other than 0 was never registered in `metadata.agents`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { parseSessionMessages } from '../logging/session-reader.js';
import type { SessionMetadata } from '../logging/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-attribution-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeLogger() {
  const info = await createSession('claude', root);
  return { logger: new SessionLogger(info), dir: info.directory };
}

async function readMetadata(dir: string): Promise<SessionMetadata> {
  return JSON.parse(await Bun.file(join(dir, 'metadata.json')).text());
}

describe('session log attribution', () => {
  it('registers every monitor, and the agents under it, with their monitor id', async () => {
    const { logger, dir } = await makeLogger();
    await logger.registerAgent('monitor-1', null, undefined, '1');
    await logger.registerAgent('app-devtools-m1-msg-1', 'monitor-1', '1/devtools', '1');
    await logger.dispose();

    const { agents } = await readMetadata(dir);
    expect(agents['monitor-0']).toMatchObject({ parentAgentId: null, monitorId: '0' });
    expect(agents['monitor-1']).toMatchObject({ parentAgentId: null, monitorId: '1' });
    expect(agents['app-devtools-m1-msg-1']).toMatchObject({
      parentAgentId: 'monitor-1',
      windowId: '1/devtools',
      monitorId: '1',
    });
  });

  it('stamps an iframe verb call and its result with the calling window and monitor', async () => {
    const { logger, dir } = await makeLogger();
    const caller = { windowId: '1/devtools', monitorId: '1' };
    logger.logVerbCall('iframe:devtools', { verb: 'list', uri: 'yaar://apps' }, caller);
    logger.logVerbResult('iframe:devtools', { ok: true }, { durationMs: 3 }, caller);
    // A caller with nothing known logs no attribution fields, not nulls.
    logger.logVerbCall('iframe:unknown', { verb: 'read', uri: 'yaar://apps' }, {});
    await logger.dispose();

    const [call, result, anonymous] = parseSessionMessages(
      await Bun.file(join(dir, 'messages.jsonl')).text(),
    );
    expect(call).toMatchObject({ type: 'tool_use', agentId: null, ...caller });
    expect(result).toMatchObject({ type: 'verb_result', durationMs: 3, ...caller });
    expect('windowId' in anonymous || 'monitorId' in anonymous).toBe(false);
  });

  it('stamps a user interaction with its monitor', async () => {
    const { logger, dir } = await makeLogger();
    logger.logInteraction({
      type: 'window.close',
      timestamp: 0,
      windowId: '1/market-apps',
      monitorId: '1',
    });
    await logger.dispose();

    const [entry] = parseSessionMessages(await Bun.file(join(dir, 'messages.jsonl')).text());
    expect(entry).toMatchObject({ type: 'interaction', windowId: '1/market-apps', monitorId: '1' });
  });
});
