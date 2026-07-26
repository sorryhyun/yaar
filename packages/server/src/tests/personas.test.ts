/**
 * Persona agents — the app-owned, tool-less agent tier.
 *
 * Three properties are worth a test and the rest is plumbing:
 *
 * 1. **Tool-lessness.** A persona's system prompt arrives at runtime from an app, so
 *    the only thing standing between "an app can name a character" and "an app can
 *    write a prompt that drives the OS" is the empty tool allowlist and what
 *    `buildSDKOptions` derives from it. Asserted end to end, against the real options
 *    builder, rather than by reading the profile back.
 * 2. **Prompt fidelity.** A persona must *be* its prompt — no environment section, no
 *    memory, no scope blurb — which the `app-` role prefix is what buys.
 * 3. **Lifecycle.** Spawn, per-app isolation, teardown, and the limiter slots each one
 *    holds. A leaked persona holds a slot out of a semaphore of ten.
 *
 * No `mock.module` here on purpose: `AgentPool` takes its provider factory as a
 * constructor argument precisely so a test can substitute one without a process-global
 * stub (see the `acquireProvider` note in agent-pool.ts).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { AgentPool, personaAgentKey } from '../agents/agent-pool.js';
import {
  buildPersonaProfile,
  isPersonaRole,
  personaRole,
  PERSONA_ID_RE,
  MAX_PERSONA_PROMPT_CHARS,
} from '../agents/profiles/persona.js';
import { getContextRestoreMessages } from '../logging/context-restore.js';
import { parseSessionMessages } from '../logging/session-reader.js';
import { monitorSource } from '../agents/context.js';
import { assembleSystemPromptForRole } from '../agents/system-prompt.js';
import { principalRole, runWithAgentContext } from '../agents/agent-context.js';
import {
  listPersonas,
  readPersonas,
  invokePersonas,
  deletePersonas,
} from '../handlers/apps/agents-resource.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import { buildSDKOptions } from '../providers/claude/sdk-options.js';
import { initMcpServer } from '../mcp/server.js';
import { getAppMeta } from '../features/apps/discovery.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { parseAppAgentsPath } from '../handlers/apps/paths.js';
import { getAgentLimiter } from '../agents/limiter.js';
import type { AITransport, StreamMessage, TransportOptions } from '../providers/types.js';
import type { SessionId } from '../session/types.js';

// ── A provider that records what it was asked to run ────────────────────────

interface Recorded {
  prompt: string;
  options: TransportOptions;
}

function fakeProvider(recorded: Recorded[]): AITransport {
  return {
    name: 'fake',
    providerType: 'claude',
    systemPrompt: 'THE GENERIC YAAR PROMPT — a persona must never be handed this.',
    async isAvailable() {
      return true;
    },
    async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
      recorded.push({ prompt, options });
      yield { type: 'text', content: `answer to ${prompt}` } as StreamMessage;
      yield { type: 'complete' } as StreamMessage;
    },
    interrupt() {},
    async dispose() {},
  };
}

// ── Profile ─────────────────────────────────────────────────────────────────

describe('persona profile', () => {
  it('carries the caller prompt verbatim and no tools at all', () => {
    const profile = buildPersonaProfile('chitchats', 'alice', 'You are Alice. You are curt.');

    expect(profile.systemPrompt).toBe('You are Alice. You are curt.');
    expect(profile.allowedTools).toEqual([]);
    expect(profile.model).toBeUndefined();
  });

  it('passes a model override through when one is given', () => {
    const profile = buildPersonaProfile('chitchats', 'bob', 'You are Bob.', 'claude-haiku-4-5');
    expect(profile.model).toBe('claude-haiku-4-5');
  });

  it('places the persona in the unprivileged app tier via its role prefix', () => {
    expect(personaRole('chitchats', 'alice')).toStartWith('app-');
    expect(principalRole(personaRole('chitchats', 'alice'))).toBe('app');
  });

  it('assembles the prompt untouched — no environment, memory, or scope section', async () => {
    const prompt = 'You are Alice. You are curt.';
    const assembled = await assembleSystemPromptForRole(
      prompt,
      personaRole('chitchats', 'alice'),
      'claude',
      '0',
    );

    expect(assembled).toBe(prompt);
  });

  it('accepts sane persona ids and rejects ids that would break keys or URIs', () => {
    for (const good of ['alice', 'A1', 'grumpy-pirate', 'x_y-9']) {
      expect(PERSONA_ID_RE.test(good)).toBe(true);
    }
    for (const bad of [
      '',
      '-lead',
      '_lead',
      'has space',
      'has/slash',
      'colon:colon',
      'a'.repeat(65),
    ]) {
      expect(PERSONA_ID_RE.test(bad)).toBe(false);
    }
  });

  it('caps the prompt well above any real character sheet', () => {
    expect(MAX_PERSONA_PROMPT_CHARS).toBeGreaterThan(10_000);
  });
});

// ── The containment ─────────────────────────────────────────────────────────

describe('persona tool-lessness (through the real SDK options builder)', () => {
  // `buildSDKOptions` mints the MCP transport header from the process-global token,
  // so the builder cannot run before the MCP server has one. Initializing it here
  // rather than stubbing keeps the assertion pointed at the production path.
  beforeAll(async () => {
    await initMcpServer();
  });

  const optionsFor = (allowedTools?: string[]) =>
    buildSDKOptions({
      options: {
        systemPrompt: 'You are Alice.',
        agentId: 'agent-1-123',
        ...(allowedTools ? { allowedTools } : {}),
      },
      defaultSystemPrompt: 'generic',
      abortController: new AbortController(),
    });

  it('connects no MCP server and enables no builtin tool', () => {
    const sdk = optionsFor(
      buildPersonaProfile('chitchats', 'alice', 'You are Alice.').allowedTools,
    );

    expect(sdk.allowedTools).toEqual([]);
    expect(sdk.tools).toEqual([]);
    expect(Object.keys(sdk.mcpServers ?? {})).toEqual([]);
  });

  it('is the empty array, not the absent one, that closes the door', () => {
    // The failure mode this guards: dropping `allowedTools` from the persona turn
    // options (or spelling it `?? undefined`) hands the persona every tool YAAR has.
    const unfiltered = optionsFor(undefined);

    expect(Object.keys(unfiltered.mcpServers ?? {}).length).toBeGreaterThan(0);
    expect(unfiltered.tools).toContain('WebSearch');
  });
});

// ── URI parsing ─────────────────────────────────────────────────────────────

describe('yaar://apps/{appId}/agents parsing', () => {
  it('parses the collection and one persona', () => {
    expect(parseAppAgentsPath('yaar://apps/chitchats/agents')).toEqual({ appId: 'chitchats' });
    expect(parseAppAgentsPath('yaar://apps/chitchats/agents/alice')).toEqual({
      appId: 'chitchats',
      personaId: 'alice',
    });
  });

  it('claims no URI belonging to another subresource', () => {
    expect(parseAppAgentsPath('yaar://apps/chitchats')).toBeNull();
    expect(parseAppAgentsPath('yaar://apps/chitchats/storage/x.json')).toBeNull();
    expect(parseAppAgentsPath('yaar://apps/chitchats/db/rooms')).toBeNull();
    expect(parseAppAgentsPath('yaar://agents/agent-1/stream')).toBeNull();
    // Nothing nests under a persona — a deeper path is not ours to answer for.
    expect(parseAppAgentsPath('yaar://apps/chitchats/agents/alice/stream')).toBeNull();
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('persona lifecycle in AgentPool', () => {
  let pool: AgentPool;
  let recorded: Recorded[];
  let slotsBefore: number;

  beforeEach(() => {
    recorded = [];
    slotsBefore = getAgentLimiter().getCurrentCount();
    pool = new AgentPool(
      'ses-personas' as SessionId,
      () => {},
      (id) => id,
      async () => fakeProvider(recorded),
    );
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  /** A cap high enough not to be the subject — the cap has its own tests below. */
  const NO_CAP = 8;

  const spawnFor = (
    monitorId: string,
    appId: string,
    personaId: string,
    prompt: string,
    max = NO_CAP,
  ) => pool.spawnPersonaAgent(monitorId, appId, personaId, { systemPrompt: prompt, max });

  /** The record, for the tests whose subject is only that a persona now exists. */
  const spawn = async (personaId: string, prompt = `You are ${personaId}.`, max = NO_CAP) => {
    const result = await spawnFor('0', 'chitchats', personaId, prompt, max);
    return 'record' in result ? result.record : null;
  };

  it('spawns, finds, and lists personas per (monitor, app)', async () => {
    const alice = await spawn('alice');
    const bob = await spawn('bob');

    expect(alice).not.toBeNull();
    expect(bob).not.toBeNull();
    expect(alice!.agent.instanceId).not.toBe(bob!.agent.instanceId);

    expect(pool.getPersonaAgent('0', 'chitchats', 'alice')?.systemPrompt).toBe('You are alice.');
    expect(pool.listPersonaAgents('0', 'chitchats').map((p) => p.subId)).toEqual(['alice', 'bob']);
  });

  it('scopes personas to their app and monitor', async () => {
    await spawn('alice');
    await spawnFor('1', 'chitchats', 'alice', 'monitor one alice');
    await spawnFor('0', 'other-app', 'alice', 'other app alice');

    // Same persona id, three independent agents — none of them each other.
    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(1);
    expect(pool.listPersonaAgents('1', 'chitchats')).toHaveLength(1);
    expect(pool.listPersonaAgents('0', 'other-app')).toHaveLength(1);
    expect(pool.getPersonaAgent('0', 'chitchats', 'alice')?.systemPrompt).toBe('You are alice.');
    expect(pool.getPersonaAgent('1', 'chitchats', 'alice')?.systemPrompt).toBe('monitor one alice');
    expect(pool.getPersonaAgent('2', 'chitchats', 'alice')).toBeUndefined();
  });

  it('runs a turn with the persona prompt and an empty tool list', async () => {
    const alice = await spawn('alice', 'You are Alice. You are curt.');
    await pool.runPersonaTurn(alice!, 'Bob said hello.', 'task-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].prompt).toBe('Bob said hello.');
    expect(recorded[0].options.systemPrompt).toBe('You are Alice. You are curt.');
    expect(recorded[0].options.allowedTools).toEqual([]);
    // Never the provider's own generic prompt.
    expect(recorded[0].options.systemPrompt).not.toContain('GENERIC YAAR');
  });

  it("records the turn's final text for a subscriber that missed the done frame", async () => {
    const alice = await spawn('alice');
    expect(alice!.lastResponse).toBeUndefined();

    await pool.runPersonaTurn(alice!, 'question', 'task-1');

    expect(alice!.lastResponse).toBe('answer to question');
  });

  it('reports personas on the roster with their app, monitor, and persona id', async () => {
    const alice = await spawn('alice');
    const entry = pool.listAgents().find((a) => a.id === alice!.agent.instanceId);

    expect(entry?.type).toBe('persona');
    expect(entry?.appId).toBe('chitchats');
    expect(entry?.monitorId).toBe('0');
    expect(entry?.subId).toBe('alice');
    expect(pool.getStats().personaAgents).toBe(1);
    // The roster is what `interruptByIdOrRole` and the monitor lookup read from.
    expect(pool.hasAgent(alice!.agent.instanceId)).toBe(true);
    expect(pool.findMonitorForAgent(alice!.agent.instanceId)).toBe('0');
    // Least-privileged tier, even though a tool call from one is unreachable anyway.
    expect(pool.getRoleForAgent(alice!.agent.instanceId)).toBe('app');
  });

  it('releases its limiter slot when disposed', async () => {
    await spawn('alice');
    await spawn('bob');
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 2);

    expect(await pool.disposePersonaAgent('0', 'chitchats', 'alice')).toBe(true);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);
    expect(pool.getPersonaAgent('0', 'chitchats', 'alice')).toBeUndefined();

    // Disposing one that was never spawned is a no-op, not a double release.
    expect(await pool.disposePersonaAgent('0', 'chitchats', 'alice')).toBe(false);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);
  });

  it('reclaims a whole cast at once, per app', async () => {
    await spawn('alice');
    await spawn('bob');
    await spawnFor('0', 'other-app', 'carol', 'carol');

    expect(await pool.disposePersonasForApp('0', 'chitchats')).toBe(2);
    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(0);
    // Another app's personas are not collateral.
    expect(pool.listPersonaAgents('0', 'other-app')).toHaveLength(1);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);
  });

  it('reclaims personas when their monitor goes away, with or without an app agent', async () => {
    // The load-bearing case: an app whose iframe spawned personas but which never
    // created an app agent. Walking app agents alone would leak every one of these.
    await spawn('alice');
    await spawn('bob');
    expect(pool.getStats().appAgents).toBe(0);

    await pool.disposeAppAgentsForMonitor('0');

    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(0);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore);
  });

  it('releases every slot on pool cleanup', async () => {
    await spawn('alice');
    await spawn('bob');
    await pool.cleanup();

    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore);
    expect(pool.getStats().personaAgents).toBe(0);
  });

  // ── Concurrency ──────────────────────────────────────────────────────────
  //
  // An app spawns its cast on mount, and `Promise.all(cast.map(spawn))` is the
  // ordinary way to write that. Every check the spawn makes therefore has to hold
  // across the await inside it, not just at the moment it was read.

  it('collapses concurrent spawns of one id into a single agent', async () => {
    const [first, second, third] = await Promise.all([
      spawnFor('0', 'chitchats', 'alice', 'You are Alice.'),
      spawnFor('0', 'chitchats', 'alice', 'You are Alice.'),
      spawnFor('0', 'chitchats', 'alice', 'You are Alice.'),
    ]);

    expect(first.status).toBe('created');
    expect(second.status).toBe('reused');
    expect(third.status).toBe('reused');

    // The failure this pins: three records, two of them in no collection at all —
    // unreachable by every dispose path *and* by cleanup(), holding a provider and a
    // MAX_AGENTS slot until the process died.
    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(1);
    expect(pool.getStats().personaAgents).toBe(1);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);

    const ids = [first, second, third].map((r) => ('record' in r ? r.record.agent.instanceId : ''));
    expect(new Set(ids).size).toBe(1);
  });

  it('holds the per-app cap against a whole cast arriving at once', async () => {
    const results = await Promise.all(
      ['alice', 'bob', 'carol', 'dave', 'erin'].map((id) =>
        spawnFor('0', 'chitchats', id, `You are ${id}.`, 2),
      ),
    );

    expect(results.filter((r) => r.status === 'created')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'at-capacity')).toHaveLength(3);
    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(2);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 2);
  });

  it('reclaims a persona whose spawn was still in flight when its app was torn down', async () => {
    // The window closes on the same tick the iframe asked for a character. Without
    // settling the reservation, the sweep finds an empty roster and the persona lands
    // a moment later with nothing left that knows to reclaim it.
    const pending = spawnFor('0', 'chitchats', 'alice', 'You are Alice.');
    const disposed = pool.disposePersonasForApp('0', 'chitchats');

    await Promise.all([pending, disposed]);

    expect(pool.listPersonaAgents('0', 'chitchats')).toHaveLength(0);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore);
  });
});

// ── Ownership ───────────────────────────────────────────────────────────────

describe('persona verb ownership', () => {
  // The handlers read only `sourceUri` off the resolved URI; the composite in
  // register.ts hands them the whole object, but nothing else is consulted.
  const uri = (u: string) => ({ sourceUri: u }) as ResolvedUri;

  /** Run as an app iframe would: the appId comes from the token, never the URI. */
  const asApp = <T>(appId: string, fn: () => T) =>
    runWithAgentContext(
      { agentId: `iframe:${appId}`, sessionId: 'ses-x' as SessionId, monitorId: '0', appId },
      fn,
    );

  const errorText = (result: { content: Array<{ type: string }>; isError?: boolean }) => {
    expect(result.isError).toBe(true);
    const block = result.content[0] as { type: 'text'; text: string };
    return block.text;
  };

  it('answers null for a URI that belongs to another subresource', async () => {
    // The composite falls through on null — claiming a storage URI here would
    // shadow app storage entirely.
    expect(await readPersonas(uri('yaar://apps/personas/storage/x.json'))).toBeNull();
    expect(await invokePersonas(uri('yaar://apps/personas'), { action: 'spawn' })).toBeNull();
    expect(await deletePersonas(uri('yaar://apps/personas/db/rooms'))).toBeNull();
  });

  it('refuses a caller that is not an app at all', async () => {
    // No appId in context: the desktop, an agent turn, a bare HTTP call. Personas
    // are app-owned and there is no principal above them to inherit one.
    const result = await listPersonas(uri('yaar://apps/personas/agents'));
    expect(errorText(result!)).toContain('app-owned');
  });

  it("refuses an app naming another app's personas", async () => {
    // The permission list says what a caller may *ask for*; this says whose personas
    // they are. Both have to agree, and this is the half the app cannot influence.
    const result = await asApp('memo', () => listPersonas(uri('yaar://apps/personas/agents')));
    expect(errorText(await result!)).toContain('cannot reach');
  });

  it('refuses an app that never declared personas, even for its own URI', async () => {
    const result = await asApp('memo', () => listPersonas(uri('yaar://apps/memo/agents')));
    expect(errorText(await result!)).toContain('may not spawn personas');
  });

  it('rejects an unknown action before it can reach the pool', async () => {
    const result = await asApp('personas', () =>
      invokePersonas(uri('yaar://apps/personas/agents'), { action: 'summon' }),
    );
    expect(errorText(await result!)).toContain('Unknown action');
  });

  it('rejects a malformed spawn without spending an agent slot', async () => {
    const slots = getAgentLimiter().getCurrentCount();

    const noPrompt = await asApp('personas', () =>
      invokePersonas(uri('yaar://apps/personas/agents'), {
        action: 'spawn',
        personaId: 'alice',
      }),
    );
    expect(errorText(await noPrompt!)).toContain('systemPrompt');

    const badId = await asApp('personas', () =>
      invokePersonas(uri('yaar://apps/personas/agents'), {
        action: 'spawn',
        personaId: 'not a valid id',
        systemPrompt: 'You are Alice.',
      }),
    );
    expect(errorText(await badId!)).toContain('Invalid personaId');

    const tooLong = await asApp('personas', () =>
      invokePersonas(uri('yaar://apps/personas/agents'), {
        action: 'spawn',
        personaId: 'alice',
        systemPrompt: 'x'.repeat(MAX_PERSONA_PROMPT_CHARS + 1),
      }),
    );
    expect(errorText(await tooLong!)).toContain('limit is');

    expect(getAgentLimiter().getCurrentCount()).toBe(slots);
  });
});

// ── Context isolation ───────────────────────────────────────────────────────

describe('persona turns stay out of the monitor context', () => {
  // A persona has no tape and no window, so its turns are logged under the *monitor's*
  // source — the same one the real user↔monitor conversation uses — and every filter
  // in context-restore keys on source alone. The role is the only thing that tells
  // them apart, which is what `isPersonaRole` exists for.
  const jsonl = (entries: Array<{ type: string; agentId: string; content: string }>) =>
    entries
      .map((e, i) =>
        JSON.stringify({
          ...e,
          timestamp: `2026-01-01T00:00:0${i}.000Z`,
          parentAgentId: null,
          source: monitorSource('0'),
        }),
      )
      .join('\n');

  it('recognizes a persona role and leaves every other role alone', () => {
    expect(isPersonaRole(personaRole('chitchats', 'alice'))).toBe(true);
    // An appId or personaId containing "-" must not break the test either way.
    expect(isPersonaRole(personaRole('round-table', 'dr-who'))).toBe(true);

    expect(isPersonaRole('app-agent-chitchats')).toBe(false);
    expect(isPersonaRole('main')).toBe(false);
    expect(isPersonaRole('session-oversight')).toBe(false);
    expect(isPersonaRole(null)).toBe(false);
    expect(isPersonaRole(undefined)).toBe(false);
  });

  it('drops persona turns from a restore and keeps the real conversation', () => {
    const messages = parseSessionMessages(
      jsonl([
        { type: 'user', agentId: 'main-a1', content: 'what did they think?' },
        { type: 'user', agentId: personaRole('personas', 'alice'), content: 'turn prompt: alice' },
        { type: 'assistant', agentId: personaRole('personas', 'alice'), content: 'Alice, curtly.' },
        { type: 'user', agentId: personaRole('personas', 'bob'), content: 'turn prompt: bob' },
        { type: 'assistant', agentId: personaRole('personas', 'bob'), content: 'Bob, at length.' },
        { type: 'assistant', agentId: 'main-a1', content: 'the room is split' },
      ]),
    );

    const restored = getContextRestoreMessages(messages);

    // What the leak looked like: six messages, four of them a room's improv replayed
    // as the user talking to the monitor agent and the monitor agent answering.
    expect(restored.map((m) => m.content)).toEqual(['what did they think?', 'the room is split']);
  });

  it("leaves the app agent's own turns in place — only personas are dropped", () => {
    const messages = parseSessionMessages(
      jsonl([{ type: 'user', agentId: 'app-agent-personas', content: 'app agent turn' }]),
    );

    expect(getContextRestoreMessages(messages)).toHaveLength(1);
  });
});

// ── The manifest gate ───────────────────────────────────────────────────────

describe('personas manifest field', () => {
  // A real installed app, because the gate is `resolveAppSource(appId) === 'bundled'`
  // and that reads the filesystem. The point of the rule is that shipping the JSON is
  // not enough — you have to be in the tree.
  const INSTALLED_ID = 'persona-gate-fixture';
  const installedDir = join(USER_APPS_DIR, INSTALLED_ID);

  beforeAll(() => {
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, 'app.json'),
      JSON.stringify({
        name: 'Gate Fixture',
        // Ungated, so the manifest still parses to something — otherwise the gates
        // strip it to nothing and `getAppMeta` answers null, which would pass the
        // assertions below for the wrong reason.
        permissions: ['yaar://apps/self/db/'],
        personas: { max: 4 },
        streams: ['agents'],
      }),
    );
  });

  afterAll(() => {
    rmSync(installedDir, { recursive: true, force: true });
  });

  it('is honored for a bundled app that declares it', async () => {
    expect((await getAppMeta('personas'))?.personas).toEqual({ max: 4 });
  });

  it('is absent for every app that does not declare it', async () => {
    expect((await getAppMeta('memo'))?.personas).toBeUndefined();
    expect((await getAppMeta('process-explorer'))?.personas).toBeUndefined();
  });

  it('is ignored for an installed app, however it spells it', async () => {
    const meta = await getAppMeta(INSTALLED_ID);

    expect(meta).not.toBeNull();
    expect(meta?.personas).toBeUndefined();
    // Same rule as `streams`, and for the same reason — asserted here so the two
    // gates cannot drift apart unnoticed.
    expect(meta?.streams).toBeUndefined();
  });
});

describe('persona key', () => {
  it('is unique across all three scoping components', () => {
    const keys = new Set([
      personaAgentKey('0', 'chitchats', 'alice'),
      personaAgentKey('1', 'chitchats', 'alice'),
      personaAgentKey('0', 'other', 'alice'),
      personaAgentKey('0', 'chitchats', 'bob'),
    ]);
    expect(keys.size).toBe(4);
  });
});
