/**
 * What a session log records about each agent, and where its entries land.
 *
 * Three gaps from GitHub issue #185:
 *
 * - The log named the provider but never the model, so two runs of one provider could
 *   not be told apart after the fact. `AgentInfo.model` records it per agent.
 * - A reused app agent (and every monitor) runs one role per turn, and the per-agent file
 *   was keyed on that role — one conversation came out as one `agents/*.jsonl` per
 *   message. The file is now keyed on the agent's stable identity (`agentLogKey`), while
 *   each entry keeps its per-turn role as `agentId`.
 * - A thinking block is logged when it ends, so its only timestamp was its end.
 *   `startedAt` records when its first delta arrived.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { parseSessionMessages } from '../logging/session-reader.js';
import type { SessionMetadata } from '../logging/types.js';
import { agentLogKey, monitorTurnRole, appRolePrefix } from '../agents/roles.js';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-agent-files-'));
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

async function agentFile(dir: string, name: string) {
  return parseSessionMessages(await Bun.file(join(dir, 'agents', `${name}.jsonl`)).text());
}

describe('agentLogKey', () => {
  it("is the agent's stable identity, which every one of its turn roles extends", () => {
    expect(agentLogKey({ kind: 'monitor', monitorId: '1' })).toBe('monitor-1');
    expect(agentLogKey({ kind: 'app', monitorId: '1', appId: 'notes' })).toBe('app-notes-m1');
    expect(
      monitorTurnRole('1', 'msg-7').startsWith(
        `${agentLogKey({ kind: 'monitor', monitorId: '1' })}-`,
      ),
    ).toBe(true);
    expect(`${appRolePrefix('1', 'notes')}-msg-7`.startsWith('app-notes-m1-')).toBe(true);
  });
});

describe('session log model', () => {
  it('records the model an agent was registered with', async () => {
    const { logger, dir } = await makeLogger();
    await logger.registerAgent('app-notes-m0-msg-1', 'monitor-0', '0/notes', '0', {
      model: 'claude-sonnet-x',
    });
    await logger.dispose();
    expect((await readMetadata(dir)).agents['app-notes-m0-msg-1'].model).toBe('claude-sonnet-x');
  });

  it('fills in the model of the monitor createSession() seeded without one', async () => {
    const { logger, dir } = await makeLogger();
    await logger.registerAgent('monitor-0', null, undefined, '0', { model: 'claude-opus-x' });
    await logger.dispose();
    expect((await readMetadata(dir)).agents['monitor-0']).toMatchObject({
      monitorId: '0',
      model: 'claude-opus-x',
    });
  });
});

describe('per-agent log files', () => {
  it("puts every turn of a reused app agent in one file, each entry under its turn's role", async () => {
    const { logger, dir } = await makeLogger();
    const logKey = agentLogKey({ kind: 'app', monitorId: '0', appId: 'notes' });

    await logger.registerAgent('app-notes-m0-msg-1', 'monitor-0', '0/notes', '0', { logKey });
    logger.logUserMessage('first', 'app-notes-m0-msg-1');
    await logger.flush();
    // The second turn's registration must not truncate what the first turn wrote.
    await logger.registerAgent('app-notes-m0-msg-2', 'monitor-0', '0/notes', '0', { logKey });
    logger.logUserMessage('second', 'app-notes-m0-msg-2');
    await logger.dispose();

    const files = (await readdir(join(dir, 'agents'))).sort();
    expect(files).toEqual(['app-notes-m0.jsonl', 'default.jsonl']);
    const entries = await agentFile(dir, 'app-notes-m0');
    expect(entries.map((e) => [e.agentId, e.content])).toEqual([
      ['app-notes-m0-msg-1', 'first'],
      ['app-notes-m0-msg-2', 'second'],
    ]);
    // Parentage still resolves per role.
    expect(entries.every((e) => e.parentAgentId === 'monitor-0')).toBe(true);

    const { agents } = await readMetadata(dir);
    expect(agents['app-notes-m0-msg-1'].logKey).toBe('app-notes-m0');
  });

  it("routes a monitor's turns into the monitor's file without registering each turn", async () => {
    const { logger, dir } = await makeLogger();
    const logKey = agentLogKey({ kind: 'monitor', monitorId: '0' });
    for (const messageId of ['msg-1', 'msg-2']) {
      const role = monitorTurnRole('0', messageId);
      logger.routeAgentLog(role, logKey);
      logger.logAssistantMessage(`reply to ${messageId}`, role);
    }
    await logger.dispose();

    expect((await readdir(join(dir, 'agents'))).sort()).toEqual([
      'default.jsonl',
      'monitor-0.jsonl',
    ]);
    const entries = await agentFile(dir, 'monitor-0');
    expect(entries.map((e) => e.agentId)).toEqual(['monitor-0-msg-1', 'monitor-0-msg-2']);
    expect(Object.keys((await readMetadata(dir)).agents)).toEqual(['monitor-0']);
  });

  it('still writes an unrouted role to a file of its own', async () => {
    const { logger, dir } = await makeLogger();
    logger.logAssistantMessage('one-off', 'ephemeral-0-msg-1');
    await logger.dispose();
    expect((await agentFile(dir, 'ephemeral-0-msg-1')).map((e) => e.content)).toEqual(['one-off']);
  });
});

describe('thinking startedAt', () => {
  it('logs each thinking block with when it started, as well as when it ended', async () => {
    const { logger, dir } = await makeLogger();
    const mapper = new StreamToEventMapper({
      role: 'monitor-0-msg1',
      providerName: 'claude',
      state: { responseText: '', thinkingText: '', currentMessageId: null },
      sendEvent: async () => {},
      logger,
      source: 'yaar://monitors/0' as ContextSource,
      monitorId: '0',
    });
    const thinking = (content: string) => ({ type: 'thinking', content }) as StreamMessage;
    const text = (content: string) => ({ type: 'text', content }) as StreamMessage;

    const before = new Date().toISOString();
    await mapper.map(thinking('Let me '));
    await Bun.sleep(15);
    await mapper.map(thinking('think.'));
    await mapper.map(text('Answer.'));
    await mapper.map(thinking('Again.'));
    await mapper.map(text('More.'));
    await logger.dispose();

    const blocks = parseSessionMessages(await Bun.file(join(dir, 'messages.jsonl')).text()).filter(
      (e) => e.type === 'thinking',
    );
    expect(blocks.map((b) => b.content)).toEqual(['Let me think.', 'Again.']);
    const [first, second] = blocks;
    expect(first.startedAt! >= before).toBe(true);
    // Started at the first delta, logged at the flush after the last one.
    expect(Date.parse(first.timestamp) - Date.parse(first.startedAt!)).toBeGreaterThanOrEqual(10);
    // Reset on flush: the second block starts after the first one ended.
    expect(second.startedAt! >= first.timestamp).toBe(true);
  });
});
