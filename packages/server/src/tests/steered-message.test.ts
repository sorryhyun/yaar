/**
 * A message steered into a running turn (issue #182, gaps 1 and 2).
 *
 * Both were observed in one run. A role brief the monitor sent an app agent that was
 * mid-turn arrived bare between two tool results, and the model read it as "a misdirected
 * broadcast… treat as noise" — the monitor waited five minutes for an answer that never
 * came. And the brief left no trace in `messages.jsonl`, only a `server.log` line, so the
 * transcript could not show what the agent had been sent.
 *
 *   1. the steered text says it is new, where it came from, and that it is the agent's to
 *      handle — around the producer's own content, unchanged
 *   2. a steer the provider took is logged as a `user` entry of the receiving agent,
 *      marked `steered`; one it refused is not logged at all
 *   3. the entry reads back like any other user turn: transcript and context restore
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { frameSteeredMessage, STEERED_TAG } from '../agents/steer-framing.js';
import { AgentSession } from '../agents/agent-session.js';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { parseSessionMessages } from '../logging/session-reader.js';
import { getContextRestoreMessages } from '../logging/context-restore.js';
import type { AITransport } from '../providers/types.js';
import { monitorSource, windowSource } from '../agents/context.js';

describe('frameSteeredMessage', () => {
  it('names the source and says the message needs handling', () => {
    const body = '<monitor:0>\nYou are the reviewer. Reply with your plan.\n</monitor:0>';
    const framed = frameSteeredMessage(body, {
      kind: 'relay',
      windowId: 'pin-preview',
      monitorId: '0',
    });

    expect(
      framed.startsWith(`<${STEERED_TAG} from="agent" window="pin-preview" monitor="0">`),
    ).toBe(true);
    expect(framed.endsWith(`</${STEERED_TAG}>`)).toBe(true);
    expect(framed).toContain('addressed to you');
    expect(framed).toContain('handle it before you end this turn');
    // The producer's own framing is the body, untouched — the wrapper adds, never rewrites.
    expect(framed).toContain(`\n${body}\n`);
  });

  it('says "user" for a user, and leaves out what the task does not carry', () => {
    const framed = frameSteeredMessage('make it blue', { kind: 'user' });
    expect(framed.split('\n')[0]).toBe(`<${STEERED_TAG} from="user">`);
  });
});

/** A provider whose `steer` answers what the test says, and records what it was sent. */
function providerThatSteers(accept: boolean) {
  const steer = mock(async (_content: string) => accept);
  return {
    provider: {
      name: 'mock',
      providerType: 'claude',
      steer,
      dispose: async () => {},
    } as unknown as AITransport,
    steer,
  };
}

/**
 * An AgentSession mid-turn, without running one. A real turn needs a provider stream, a
 * system prompt and an environment section; the steer reads only these two fields, and
 * they are exactly what `runTurn` sets on its way in.
 */
function midTurn(session: AgentSession, role: string): void {
  const internals = session as unknown as { running: boolean; currentRole: string | null };
  internals.running = true;
  internals.currentRole = role;
}

describe('AgentSession.steer logs what the provider took', () => {
  let root: string;
  let logger: SessionLogger;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yaar-steer-'));
    const created = await createSession('claude', root);
    directory = created.directory;
    logger = new SessionLogger(created);
  });

  afterEach(async () => {
    await logger.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function entries() {
    await logger.flush();
    return parseSessionMessages(await readFile(join(directory, 'messages.jsonl'), 'utf8'));
  }

  it('records a taken steer as a user entry of the receiving agent', async () => {
    const session = new AgentSession('conn-steer', undefined, () => logger);
    const { provider, steer } = providerThatSteers(true);
    session.attachProvider(provider);
    midTurn(session, 'app-0-pin-preview-m1');

    const framed = frameSteeredMessage('<monitor:0>\nbrief\n</monitor:0>', {
      kind: 'relay',
      windowId: 'pin-preview',
      monitorId: '0',
    });
    expect(await session.steer(framed, windowSource('0/pin-preview'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(framed);

    const logged = await entries();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      type: 'user',
      agentId: 'app-0-pin-preview-m1',
      content: framed,
      steered: true,
      source: 'yaar://windows/0/pin-preview',
    });
    await session.cleanup();
  });

  it('records nothing when the provider refuses the steer', async () => {
    // The caller queues or reroutes a refused steer, and it is logged as the turn it
    // becomes. Logging it here too would put the same message in the transcript twice.
    const session = new AgentSession('conn-steer', undefined, () => logger);
    session.attachProvider(providerThatSteers(false).provider);
    midTurn(session, 'app-0-pin-preview-m1');

    expect(await session.steer('ignored')).toBe(false);
    expect(await entries()).toHaveLength(0);
    await session.cleanup();
  });

  it('reads back as an ordinary user turn', async () => {
    logger.logSteeredMessage('steered text', 'monitor-0-m1', monitorSource('0'));
    const logged = await entries();

    expect(getContextRestoreMessages(logged)).toMatchObject([
      { role: 'user', content: 'steered text', source: 'yaar://monitors/0' },
    ]);
  });
});
