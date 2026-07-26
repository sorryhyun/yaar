/**
 * S9 — a `protocol`-grade sub-agent's tool call, end to end.
 *
 * The grade's whole claim is that an app-defined tool *is* one command sent to the
 * app's own iframe, and that the app's answer comes back as the tool result. Both
 * halves are bridge behavior, so both are asserted against the real bridge here:
 * `dispatchSubAgentTool` → `handleAppCommand` → `actionEmitter.emitAppProtocolRequest`
 * → the socket → the fake browser → back. A mocked bridge would prove nothing about
 * the one thing this grade adds.
 *
 * What the assertions are actually protecting:
 *
 * - **The command name** — `persona:{tool}`, not `{tool}`. It is the flag that keeps
 *   the app agent's manifest and the sub-agent's tool list from being read as each
 *   other's (see `features/apps/persona-commands.ts`).
 * - **The `personaId` stamp** — the app must know *which* character is remembering,
 *   and the server stamps it last so a model that can name one cannot write another's.
 * - **Failure is a tool result, not a dead turn.** No window and a silent app both
 *   come back as errors the model can read and answer around.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import type { OSAction } from '@yaar/shared';
import type { SubAgent } from '../../agents/agent-pool.js';

const { dispatchSubAgentTool } = await import('../../mcp/sub-agent/index.js');
const { runWithAgentContext } = await import('../../agents/agent-context.js');
const { handleAppQuery } = await import('../../features/window/app-protocol.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const TOOLS = [
  { name: 'skip', description: 'Decline this turn.' },
  {
    name: 'memorize',
    description: 'Save a lasting fact you learned about someone.',
    input: { fact: { type: 'string' as const } },
  },
];

async function waitForPool(h: Harness) {
  for (let i = 0; i < 100; i++) {
    const pool = h.session.getPool();
    if (pool) return pool;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('harness: the session never initialized its pool');
}

/**
 * A booted session with one registered app window and one `protocol` sub-agent of
 * that app, spawned straight on the pool (the verb surface has its own tests).
 */
async function bootSubAgentSession(opts: { answerWith?: unknown; silent?: boolean } = {}) {
  const h = await boot();
  harness = h;
  const windowKey = h.seedIframeWindow('chitchats');

  await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

  if (!opts.silent) {
    h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, async (frame) => {
      const response =
        frame.request.kind === 'manifest'
          ? {
              kind: 'manifest' as const,
              manifest: {
                appId: 'chitchats',
                name: 'ChitChats',
                state: {},
                commands: {
                  addCharacter: { description: 'Write a new character into the cast' },
                  'persona:memorize': { description: 'write a character memory row' },
                },
              },
            }
          : { kind: 'command' as const, result: opts.answerWith ?? { saved: true } };
      await h.client.deliver({
        type: ClientEventType.APP_PROTOCOL_RESPONSE,
        requestId: frame.requestId,
        windowId: frame.windowId,
        response,
      });
    });
  }

  // The session initializes its pool off the connect, not inside it (`void
  // ensureInitialized()`), so a caller that needs the pool waits for it the way the
  // first real message does.
  const pool = (await waitForPool(h)).agentPool;
  const spawned = await pool.spawnSubAgent('0', 'chitchats', 'alice', {
    systemPrompt: 'You are Alice.',
    max: 4,
    tools: TOOLS,
  });
  if (!('record' in spawned)) throw new Error(`sub-agent spawn failed: ${spawned.status}`);

  const record: SubAgent = spawned.record;
  /** Call a tool the way the MCP handler does — as the sub-agent, in its own context. */
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    runWithAgentContext(
      {
        agentId: record.agent.instanceId,
        sessionId: h.sessionId,
        monitorId: '0',
      },
      () => dispatchSubAgentTool(record, tool, args),
    );

  return { h, windowKey, record, call };
}

/** The text block of a VerbResult, which is what the model actually reads. */
function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('S9 — a protocol sub-agent tool reaches its own app and comes back', () => {
  it("dispatches persona:{tool}, stamped with the caller's id, and returns the app's reply", async () => {
    const { h, call } = await bootSubAgentSession({ answerWith: { saved: true, id: 7 } });

    const result = await call('memorize', { fact: 'alice likes rain' });

    const requests = h.client
      .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
      .filter((f) => f.request.kind === 'command');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request).toEqual({
      kind: 'command',
      command: 'persona:memorize',
      params: { fact: 'alice likes rain', personaId: 'alice' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('saved');
  });

  it('stamps personaId last, so a sub-agent cannot answer as another character', async () => {
    const { h, call } = await bootSubAgentSession();

    await call('memorize', { fact: 'x', personaId: 'bob' });

    const request = h.client
      .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
      .find((f) => f.request.kind === 'command')!.request as {
      params: Record<string, unknown>;
    };
    expect(request.params.personaId).toBe('alice');
  });

  it('carries a no-argument tool through as the signal it is', async () => {
    // `skip` is why these are tools and not output sentinels: the app learns the
    // character declined *as an event*, with no text to parse.
    const { h, call } = await bootSubAgentSession({ answerWith: 'ok' });

    await call('skip');

    const request = h.client
      .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
      .find((f) => f.request.kind === 'command')!.request as {
      command: string;
      params: Record<string, unknown>;
    };
    expect(request.command).toBe('persona:skip');
    expect(request.params).toEqual({ personaId: 'alice' });
  });

  it('turns a silent app into a tool error, not a dead turn', async () => {
    const { call } = await bootSubAgentSession({ silent: true });

    const result = await call('memorize', { fact: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not respond');
  });

  it('refuses when the app has no open window on this monitor', async () => {
    const { h, record, call } = await bootSubAgentSession();
    // The window closes under the sub-agent — the ordinary case, since a sub-agent
    // outlives any single command but not its app's presence on screen.
    h.session.windowState.handleAction(
      { type: 'window.close', windowId: 'chitchats' } as OSAction,
      '0',
    );

    const result = await call('memorize', { fact: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no open "chitchats" window');
    expect(record.subId).toBe('alice');
  });

  it("hides persona-audience commands from the app agent's manifest", async () => {
    // Same iframe, two audiences: the app agent asking for the manifest must not see
    // the character-facing handlers, whose descriptions are written for a character.
    const { h, windowKey } = await bootSubAgentSession();

    // As the app agent would ask it — inside its own turn context, so the request is
    // addressed to this session rather than to whatever the hub's default happens to be.
    const manifest = await runWithAgentContext(
      { agentId: 'app-agent-chitchats', sessionId: h.sessionId, monitorId: '0' },
      () => handleAppQuery(h.session.windowState, windowKey, { stateKey: 'manifest' }),
    );

    expect(textOf(manifest)).toContain('addCharacter');
    expect(textOf(manifest)).not.toContain('persona:memorize');
  });
});
