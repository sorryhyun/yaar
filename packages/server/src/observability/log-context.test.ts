/**
 * The seam between the logger and the agent context, exercised end to end.
 *
 * `log.test.ts` covers the logger with a hand-written resolver, and the loopback suite covers
 * the server with no resolver wired at all (`lifecycle.initializeSubsystems` is not what boots
 * it). Neither runs the pairing that actually ships: the real `getLogContext` reading a real
 * `AsyncLocalStorage` store entered by a real `runInAgentContext`. That pairing is the whole
 * feature — a log call anywhere inside a turn carrying its ids without being handed them — so
 * it gets its own file rather than being assumed from the two halves.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createLogger,
  configureLogging,
  setLogContextResolver,
  resetLogContextResolver,
} from './log.js';
import { getLogContext, runInAgentContext, runWithAgentContext } from '../agents/agent-context.js';
import type { ConnectionId } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';

let lines: string[] = [];
const realLog = console.log;

beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  configureLogging({ level: 'info', format: 'json' });
  // The wiring lifecycle.ts performs at boot.
  setLogContextResolver(getLogContext);
});

afterEach(() => {
  console.log = realLog;
  configureLogging({ level: 'info', format: 'pretty' });
  resetLogContextResolver();
});

const log = createLogger('probe');

describe('log context from a real agent turn', () => {
  test('a log call inside runInAgentContext carries the turn’s ids', () => {
    runInAgentContext(
      {
        agentId: 'agent-7',
        connectionId: 'conn-1' as ConnectionId,
        sessionId: 'ses-abc' as SessionId,
        monitorId: '2',
        windowId: '2/notes',
        role: 'monitor',
      },
      () => log.info('inside the turn'),
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      message: 'inside the turn',
      agentId: 'agent-7',
      sessionId: 'ses-abc',
      monitorId: '2',
      windowId: '2/notes',
    });
  });

  test('the ids survive an await — the point of using AsyncLocalStorage', async () => {
    await runInAgentContext(
      {
        agentId: 'agent-8',
        connectionId: 'conn-2' as ConnectionId,
        sessionId: 'ses-def' as SessionId,
        monitorId: '0',
      },
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        log.info('after two awaits');
      },
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      agentId: 'agent-8',
      sessionId: 'ses-def',
      monitorId: '0',
    });
  });

  test('an MCP-restored context (runWithAgentContext) carries its appId too', () => {
    runWithAgentContext(
      { agentId: 'iframe:notes', sessionId: 'ses-x' as SessionId, appId: 'notes' },
      () => log.info('from an iframe verb call'),
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      agentId: 'iframe:notes',
      sessionId: 'ses-x',
      appId: 'notes',
    });
  });

  test('outside any turn the same call logs cleanly, with no ids', () => {
    log.info('at boot');
    const line = JSON.parse(lines[0]);
    expect(line.message).toBe('at boot');
    expect(line).not.toHaveProperty('agentId');
    expect(line).not.toHaveProperty('sessionId');
  });

  test('the empty-string sessionId placeholder is reported as absent, not as ""', () => {
    // `runWithAgentContext` falls back to `'' as SessionId` when it has none to inherit.
    // An empty id in a log line reads as "session unknown" spelled the confusing way.
    runWithAgentContext({ agentId: 'agent-9' }, () => log.info('no session to inherit'));

    const line = JSON.parse(lines[0]);
    expect(line.agentId).toBe('agent-9');
    expect(line).not.toHaveProperty('sessionId');
  });

  test('a nested turn reports the inner ids, not the outer', () => {
    runInAgentContext(
      {
        agentId: 'monitor-agent',
        connectionId: 'c' as ConnectionId,
        sessionId: 's' as SessionId,
        monitorId: '0',
      },
      () => {
        runWithAgentContext({ agentId: 'app-agent', appId: 'notes' }, () => log.info('inner'));
      },
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      agentId: 'app-agent',
      appId: 'notes',
      // Inherited from the enclosing store, which is what runWithAgentContext promises.
      sessionId: 's',
      monitorId: '0',
    });
  });
});
