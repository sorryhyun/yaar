/**
 * What a sub-agent may touch — and, more to the point, what a *runtime-supplied
 * prompt* may not.
 *
 * A sub-agent is the one tier whose system prompt arrives at runtime, from an app,
 * so its capabilities are the half that has to be nailed down in code. Three claims:
 *
 * 1. **Reach.** A sub-agent's turn carries exactly the bridge tools it was spawned
 *    with and nothing of YAAR's — asserted against the real `buildSDKOptions`, and
 *    asserted again on a live turn whose owning app declares `controls` (a grant to
 *    the app *agent*, which must not descend).
 * 2. **Tool-less means tool-less.** Spawned without `tools`, the allowlist is `[]` —
 *    which `buildSDKOptions` reads as "connect no MCP servers at all". The dangerous
 *    near-miss is `undefined`, which that same function reads as *every* tool YAAR
 *    has, so the empty case gets its own assertions rather than riding along.
 * 3. **Declaration, not composition.** The tool list is validated, capped, and mapped
 *    through `subAgentToolName`, so a caller-supplied string becomes a tool in the one
 *    bridge namespace or is not a tool at all.
 *
 * The round trip itself (tool call → iframe → tool result) is a loopback test —
 * `loopback/loopback-subagent-protocol.test.ts` — because a fake bridge would prove
 * nothing about the bridge.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { AgentPool } from '../agents/agent-pool.js';
import type { SubAgent } from '../agents/agent-pool.js';
import {
  buildSubAgentProfile,
  isSubAgentRole,
  parseToolSpec,
  subAgentRole,
  subAgentToolName,
  toolSpecChars,
  MAX_SUB_AGENT_TOOLS,
} from '../agents/profiles/sub-agent.js';
import { principalRole, runWithAgentContext } from '../agents/agent-context.js';
import { assembleSystemPromptForRole } from '../agents/system-prompt.js';
import { invokePersonas } from '../handlers/apps/agents-resource.js';
import type { ResolvedUri } from '../handlers/uri-resolve.js';
import { buildSDKOptions } from '../providers/claude/sdk-options.js';
import { initMcpServer } from '../mcp/server.js';
import { getAppMeta } from '../features/apps/discovery.js';
import { APPS_DIR } from '../features/apps/roots.js';
import { withoutPersonaCommands, personaCommandFor } from '../features/apps/persona-commands.js';
import { getAgentLimiter } from '../agents/limiter.js';
import type { AITransport, StreamMessage, TransportOptions } from '../providers/types.js';
import type { SessionId } from '../session/types.js';

interface Recorded {
  prompt: string;
  options: TransportOptions;
}

function fakeProvider(recorded: Recorded[]): AITransport {
  return {
    name: 'fake',
    providerType: 'claude',
    systemPrompt: 'THE GENERIC YAAR PROMPT — a sub-agent must never be handed this.',
    async isAvailable() {
      return true;
    },
    async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
      recorded.push({ prompt, options });
      yield { type: 'text', content: 'ok' } as StreamMessage;
      yield { type: 'complete' } as StreamMessage;
    },
    interrupt() {},
    async dispose() {},
  };
}

const SKIP = { name: 'skip', description: 'Decline this turn — you have nothing to add.' };
const MEMORIZE = {
  name: 'memorize',
  description: 'Save a lasting fact you learned about someone.',
  input: { fact: { type: 'string' as const } },
};

// ── Role and profile ────────────────────────────────────────────────────────

describe('the sub-agent profile', () => {
  it('files the turn in the unprivileged app tier, prompt untouched', async () => {
    const role = subAgentRole('chitchats', 'alice');

    expect(role).toStartWith('app-');
    expect(principalRole(role)).toBe('app');
    // The prompt *is* the sub-agent — no environment section, no memory, no scope blurb.
    expect(await assembleSystemPromptForRole('You are Alice.', role, 'claude', '0')).toBe(
      'You are Alice.',
    );
  });

  it('is recognized as a sub-agent role, so restore drops it', () => {
    // The restore filter keys on this alone: a sub-agent's turns are logged under the
    // *monitor's* source, so a role this predicate misses comes back from a reload as
    // the monitor agent's own history.
    expect(isSubAgentRole(subAgentRole('chitchats', 'alice'))).toBe(true);
    expect(isSubAgentRole('app-agent-chitchats')).toBe(false);
    expect(isSubAgentRole('main')).toBe(false);
    expect(isSubAgentRole(null)).toBe(false);
  });

  it('derives the allowlist from the declared tools, and empties it when there are none', () => {
    const toolLess = buildSubAgentProfile({
      appId: 'chitchats',
      subId: 'alice',
      systemPrompt: 'You are Alice.',
    });
    // `[]`, never `undefined` — see the file header.
    expect(toolLess.allowedTools).toEqual([]);
    expect(toolLess.systemPrompt).toBe('You are Alice.');

    const armed = buildSubAgentProfile({
      appId: 'chitchats',
      subId: 'alice',
      systemPrompt: 'You are Alice.',
      tools: [SKIP, MEMORIZE],
    });
    expect(armed.allowedTools).toEqual(['mcp__subagent__skip', 'mcp__subagent__memorize']);
  });
});

// ── Reach ───────────────────────────────────────────────────────────────────

describe('sub-agent reach (through the real SDK options builder)', () => {
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

  it('connects the subagent namespace and nothing else', () => {
    const profile = buildSubAgentProfile({
      appId: 'chitchats',
      subId: 'alice',
      systemPrompt: 'You are Alice.',
      tools: [SKIP, MEMORIZE],
    });

    const sdk = optionsFor(profile.allowedTools);

    // One MCP server, whose every tool is a name over the bridge to this app's own
    // iframe. No verbs, no app, no messaging, no WebSearch, no Task.
    expect(Object.keys(sdk.mcpServers ?? {})).toEqual(['subagent']);
    expect(sdk.allowedTools).toEqual(['mcp__subagent__skip', 'mcp__subagent__memorize']);
    expect(sdk.tools).toEqual([]);
  });

  it('connects nothing at all for a tool-less sub-agent', () => {
    const profile = buildSubAgentProfile({
      appId: 'chitchats',
      subId: 'alice',
      systemPrompt: 'You are Alice.',
    });

    const sdk = optionsFor(profile.allowedTools);

    expect(Object.keys(sdk.mcpServers ?? {})).toEqual([]);
    expect(sdk.tools).toEqual([]);
    // The near-miss this guards: `allowedTools: undefined` reaches
    // `allowedTools ?? getToolNames()` and hands a runtime prompt every tool YAAR has.
    expect(sdk.allowedTools).toEqual([]);
  });

  it('cannot be widened by what the tool list says — only by how long it is', () => {
    // The failure this guards: a tool list that could name `mcp__verbs__invoke`. Names
    // are mapped through `subAgentToolName`, so a caller-supplied string becomes a tool
    // in one namespace or is not a tool at all.
    const profile = buildSubAgentProfile({
      appId: 'chitchats',
      subId: 'alice',
      systemPrompt: 'p',
      tools: [{ name: 'invoke', description: 'looks like a verb, is not one' }],
    });

    expect(profile.allowedTools).toEqual([subAgentToolName('invoke')]);
    expect(Object.keys(optionsFor(profile.allowedTools).mcpServers ?? {})).toEqual(['subagent']);
  });
});

// ── Tool specs ──────────────────────────────────────────────────────────────

describe('spawn-time tool specs', () => {
  it('accepts the shorthand and the object form', () => {
    const parsed = parseToolSpec({
      name: 'memorize',
      description: 'Save a fact.',
      input: {
        fact: 'string',
        weight: { type: 'number', description: 'How sure?', optional: true },
      },
    });

    expect('tool' in parsed && parsed.tool.input).toEqual({
      fact: { type: 'string' },
      weight: { type: 'number', description: 'How sure?', optional: true },
    });
  });

  it('refuses names and types that would not survive the round trip', () => {
    for (const bad of [
      { name: 'has space', description: 'd' },
      { name: 'persona:skip', description: 'd' },
      { name: 'skip' },
      { name: 'skip', description: '   ' },
      { name: 'skip', description: 'd', input: { fact: 'date' } },
      { name: 'skip', description: 'd', input: { 'bad name': 'string' } },
      'skip',
      null,
    ]) {
      expect(parseToolSpec(bad)).toHaveProperty('error');
    }
  });

  it('counts the prompt material a tool list spends', () => {
    expect(toolSpecChars([SKIP])).toBe(SKIP.name.length + SKIP.description.length);
    expect(toolSpecChars([MEMORIZE])).toBeGreaterThan(MEMORIZE.description.length);
  });
});

// ── The manifest gate ───────────────────────────────────────────────────────

describe('the subagents manifest field', () => {
  // The gate is `resolveAppSource(appId) === 'bundled'`, which reads the filesystem,
  // so a real directory under `apps/` is what these assertions need. No shipped app
  // declares the field today — `chitchats`, the reference consumer, installs from the
  // market now — and a fixture is what keeps the gate tested against the tree rather
  // than against whichever app currently wants a cast.
  const DECLARING_APP = 'sub-agent-gate-fixture';
  const declaringDir = join(APPS_DIR, DECLARING_APP);

  beforeAll(() => {
    mkdirSync(declaringDir, { recursive: true });
    writeFileSync(
      join(declaringDir, 'app.json'),
      JSON.stringify({ name: 'Gate Fixture', personas: { max: 4 } }),
    );
  });

  afterAll(() => {
    rmSync(declaringDir, { recursive: true, force: true });
  });

  const uri = (u: string) => ({ sourceUri: u }) as ResolvedUri;
  const asApp = <T>(appId: string, fn: () => T) =>
    runWithAgentContext(
      { agentId: `iframe:${appId}`, sessionId: 'ses-subagent' as SessionId, monitorId: '0', appId },
      fn,
    );

  it('reads "personas" as the ceiling, spelled the old way', async () => {
    // Shipped wire format: `personas` and `subagents` are the same declaration, and
    // the older spelling stays valid forever.
    expect((await getAppMeta(DECLARING_APP))?.subagents).toEqual({ max: 4 });
  });

  it('rejects a malformed spawn without spending an agent slot', async () => {
    const slots = getAgentLimiter().getCurrentCount();

    for (const tools of [
      'not-an-array',
      Array.from({ length: MAX_SUB_AGENT_TOOLS + 1 }, (_, i) => ({
        name: `t${i}`,
        description: 'd',
      })),
      [SKIP, { name: 'skip', description: 'again' }],
    ]) {
      const result = await asApp(DECLARING_APP, () =>
        invokePersonas(uri(`yaar://apps/${DECLARING_APP}/agents`), {
          action: 'spawn',
          personaId: 'alice',
          systemPrompt: 'You are Alice.',
          tools,
        }),
      );
      expect((await result!).isError).toBe(true);
    }

    expect(getAgentLimiter().getCurrentCount()).toBe(slots);
  });

  it('refuses an app that declared no ceiling at all', async () => {
    const result = await asApp('storage', () =>
      invokePersonas(uri('yaar://apps/storage/agents'), {
        action: 'spawn',
        personaId: 'alice',
        systemPrompt: 'You are Alice.',
      }),
    );

    expect((await result!).isError).toBe(true);
  });
});

// ── Persona-audience commands ───────────────────────────────────────────────

describe('persona-audience commands', () => {
  const protocol = {
    state: { room: { description: 'the room' } },
    commands: {
      addCharacter: { description: 'Write a new character into the cast' },
      [personaCommandFor('memorize')]: { description: 'write a character memory row' },
    },
  };

  it('hides them from an agent-facing manifest and leaves the rest alone', () => {
    const hidden = withoutPersonaCommands(protocol);

    expect(Object.keys(hidden.commands)).toEqual(['addCharacter']);
    expect(hidden.state).toBe(protocol.state);
  });

  it('returns the same object when there is nothing to hide', () => {
    const plain = { commands: { addCharacter: { description: 'x' } } };
    expect(withoutPersonaCommands(plain)).toBe(plain);
  });
});

// ── Lifecycle, with hands ───────────────────────────────────────────────────

describe('tool-bearing sub-agents in AgentPool', () => {
  let pool: AgentPool;
  let recorded: Recorded[];
  let slotsBefore: number;

  beforeEach(() => {
    recorded = [];
    slotsBefore = getAgentLimiter().getCurrentCount();
    pool = new AgentPool(
      'ses-subagent' as SessionId,
      () => {},
      (id) => id,
      async () => fakeProvider(recorded),
    );
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  const spawn = async (subId = 'alice', tools = [SKIP, MEMORIZE]): Promise<SubAgent | null> => {
    // `devtools` is the app that declares `controls` — a grant to the app *agent*.
    // Law 2 says it must not descend, and the turn below is where that is checked.
    const result = await pool.spawnSubAgent('0', 'devtools', subId, {
      systemPrompt: `You are ${subId}.`,
      max: 4,
      tools,
    });
    return 'record' in result ? result.record : null;
  };

  it('runs a turn with the bridge tools and nothing the owning app was granted', async () => {
    const alice = await spawn();
    await pool.runSubAgentTurn(alice!, 'Bob said hello.', 'task-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].options.systemPrompt).toBe('You are alice.');
    expect(recorded[0].options.allowedTools).toEqual([
      'mcp__subagent__skip',
      'mcp__subagent__memorize',
    ]);
    // Not the app agent's toolset, and not the app's `controls`/`direct_message` grants.
    expect(recorded[0].options.allowedTools).not.toContain('mcp__app__command');
    expect(recorded[0].options.allowedTools).not.toContain('mcp__messaging__direct_message');
  });

  it('runs a tool-less turn with an empty allowlist, not an absent one', async () => {
    const bob = await spawn('bob', []);
    await pool.runSubAgentTurn(bob!, 'Say hello.', 'task-2');

    expect(recorded[0].options.allowedTools).toEqual([]);
  });

  it('shares one cap and one teardown whether or not there are tools', async () => {
    await spawn('alice');
    await pool.spawnSubAgent('0', 'devtools', 'bob', { systemPrompt: 'You are Bob.', max: 4 });

    expect(pool.listSubAgents('0', 'devtools').map((s) => s.tools.length)).toEqual([2, 0]);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 2);

    // A slot is a provider process either way — one ceiling, one sweep.
    expect(await pool.disposeSubAgentsForApp('0', 'devtools')).toBe(2);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore);
  });

  it('is findable by agent id — the lookup the MCP door resolves tools through', async () => {
    const alice = await spawn();

    const found = pool.findSubAgentForAgent(alice!.agent.instanceId);
    expect(found?.subId).toBe('alice');
    expect(found?.tools.map((t) => t.name)).toEqual(['skip', 'memorize']);
    expect(pool.findSubAgentForAgent('agent-nobody')).toBeUndefined();
    // Least-privileged tier: its tool calls *do* arrive over MCP, and this is the role
    // the session-principal gate reads.
    expect(pool.getRoleForAgent(alice!.agent.instanceId)).toBe('app');
  });

  it('hangs under its app in the tree', async () => {
    await spawn('alice');
    await pool.spawnSubAgent('0', 'devtools', 'bob', { systemPrompt: 'You are Bob.', max: 4 });

    const [monitor] = pool.agentTree();
    const app = monitor.children?.[0];

    expect(app?.type).toBe('app');
    expect(app?.id).toBeNull(); // vacant owner slot — no app agent was ever needed
    expect(app?.children?.map((c) => c.type)).toEqual(['persona', 'persona']);
  });
});
