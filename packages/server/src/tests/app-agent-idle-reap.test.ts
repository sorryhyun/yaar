/**
 * The app-agent idle reaper.
 *
 * App agents are the one tier nothing else reclaims — not window close, not idleness,
 * only `fresh:true`, monitor removal, explicit delete, or session teardown. Against a
 * *process-global* `MAX_AGENTS` of ten, that meant eight apps opened once and left
 * alone permanently held eight slots, and the ninth app — plus every other session on
 * the machine — got "Agent limit reached" until the process restarted.
 * `PooledAgent.idleTimer` was always null and `lastUsed` was written and never read:
 * the struct advertised a reaper that did not exist, on the one tier that needed one.
 *
 * The interval that drives it is real time, so these tests age agents by writing
 * `lastUsed` and call the sweep directly. What is under test is the sweep's decisions,
 * not `setInterval`.
 *
 * No `mock.module`: `AgentPool` takes its provider factory as a constructor argument
 * precisely so a test can substitute one (see the `acquireProvider` note in
 * agent-pool.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { AgentPool } from '../agents/agent-pool.js';
import { getAgentLimiter } from '../agents/limiter.js';
import { APP_AGENT_IDLE_MS } from '../config.js';
import type { AITransport, StreamMessage } from '../providers/types.js';
import type { SessionId } from '../session/types.js';

function fakeProvider(): AITransport {
  return {
    name: 'fake',
    providerType: 'claude',
    systemPrompt: '',
    async isAvailable() {
      return true;
    },
    async *query(): AsyncIterable<StreamMessage> {
      yield { type: 'complete' } as StreamMessage;
    },
    async interrupt() {
      return { outcome: 'acknowledged' as const };
    },
    async dispose() {},
  };
}

/** Reach the private sweep — the interval that calls it is wall-clock. */
const sweep = (pool: AgentPool) =>
  (pool as unknown as { reapIdleAppAgents: () => Promise<void> }).reapIdleAppAgents();

/** Backdate an agent past the idle TTL. */
function age(pool: AgentPool, monitorId: string, appId: string, byMs = APP_AGENT_IDLE_MS + 1) {
  const agent = pool.getAppAgent(monitorId, appId)!;
  agent.lastUsed = Date.now() - byMs;
  return agent;
}

describe('app-agent idle reaper', () => {
  let pool: AgentPool;
  let slotsBefore: number;

  beforeEach(() => {
    slotsBefore = getAgentLimiter().getCurrentCount();
    pool = new AgentPool(
      'ses-idle-reap' as SessionId,
      () => {},
      (id) => id,
      async () => fakeProvider(),
    );
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('disposes an app agent that has gone quiet, and returns its slot', async () => {
    await pool.getOrCreateAppAgent('0', 'memo');
    expect(pool.hasAppAgent('0', 'memo')).toBe(true);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);

    age(pool, '0', 'memo');
    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(false);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore);
  });

  it('leaves an agent that is still within its TTL', async () => {
    await pool.getOrCreateAppAgent('0', 'memo');

    age(pool, '0', 'memo', APP_AGENT_IDLE_MS - 60_000);
    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(true);
  });

  it('never reaps a busy agent, and restarts its clock when it goes quiet', async () => {
    await pool.getOrCreateAppAgent('0', 'memo');

    // `lastUsed` is stamped at turn *start*, so a turn longer than the TTL would leave
    // the agent instantly reapable the moment it finished. The sweep refreshes a busy
    // agent instead of skipping it, so the idle clock starts when the turn ends.
    const agent = age(pool, '0', 'memo');
    agent.currentRole = 'app-memo';

    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(true);
    expect(Date.now() - agent.lastUsed).toBeLessThan(APP_AGENT_IDLE_MS);
  });

  it('reaps each expired app independently, on the monitor that owns it', async () => {
    await pool.getOrCreateAppAgent('0', 'memo');
    await pool.getOrCreateAppAgent('0', 'notes');
    await pool.getOrCreateAppAgent('1', 'memo');

    age(pool, '0', 'memo');
    age(pool, '1', 'memo');
    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(false);
    expect(pool.hasAppAgent('1', 'memo')).toBe(false);
    // Untouched: the key is (monitor, app), and `notes` was never idle.
    expect(pool.hasAppAgent('0', 'notes')).toBe(true);
    expect(getAgentLimiter().getCurrentCount()).toBe(slotsBefore + 1);
  });

  it('restarts the clock when the agent is handed out, before its turn begins', async () => {
    await pool.getOrCreateAppAgent('0', 'memo');
    age(pool, '0', 'memo');

    // Between `getOrCreateAppAgent` returning and `runAgentTurn` stamping `lastUsed`,
    // the agent is neither busy nor recently used. Touching it on the reuse path is
    // what keeps the sweep from taking it out from under its caller.
    await pool.getOrCreateAppAgent('0', 'memo');
    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(true);
  });

  it("leaves the app's sub-agents alone, exactly as a `fresh` turn does", async () => {
    await pool.getOrCreateAppAgent('0', 'memo');
    const spawned = await pool.subAgents.spawn('0', 'memo', 'alice', {
      systemPrompt: 'You are Alice.',
      max: 4,
    });
    expect('record' in spawned).toBe(true);

    age(pool, '0', 'memo');
    await sweep(pool);

    expect(pool.hasAppAgent('0', 'memo')).toBe(false);
    // A sub-agent's owner is the (monitor, app) pair, not the app agent — same rule
    // that keeps them alive across `fresh: true`.
    expect(pool.subAgents.get('0', 'memo', 'alice')).toBeTruthy();
  });
});
