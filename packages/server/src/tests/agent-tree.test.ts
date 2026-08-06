/**
 * `buildAgentTree` — the roster, nested by ownership.
 *
 * Pure over `AgentEntry[]`, so these tests hand-build rosters rather than standing up
 * a pool: the interesting cases are shapes the live pool reaches rarely (a persona
 * whose app agent was never created, an app agent on a monitor with none) and would
 * be laborious to arrange for real. `personas.test.ts` and `multi-monitor.test.ts`
 * cover the entries themselves.
 */

import { describe, it, expect } from 'bun:test';
import { buildAgentTree, type AgentEntry } from '../agents/agent-roster.js';

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function entry(partial: Partial<AgentEntry> & Pick<AgentEntry, 'id' | 'type'>): AgentEntry {
  return { label: partial.id, busy: false, usage: ZERO, ...partial };
}

describe('buildAgentTree', () => {
  it('nests monitor under session, app under monitor, sub-agent under app', () => {
    const tree = buildAgentTree([
      entry({ id: 's', type: 'session' }),
      entry({ id: 'm0', type: 'monitor', monitorId: '0' }),
      entry({ id: 'a', type: 'app', monitorId: '0', appId: 'chitchats' }),
      entry({
        id: 'p',
        type: 'persona',
        monitorId: '0',
        appId: 'chitchats',
        subId: 'alice',
      }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('s');
    const monitor = tree[0]!.children![0]!;
    expect(monitor.id).toBe('m0');
    const app = monitor.children![0]!;
    expect(app.id).toBe('a');
    expect(app.children!.map((c) => c.id)).toEqual(['p']);
  });

  it('keeps two monitors running the same app as disjoint subtrees', () => {
    const tree = buildAgentTree([
      entry({ id: 's', type: 'session' }),
      entry({ id: 'm0', type: 'monitor', monitorId: '0' }),
      entry({ id: 'm1', type: 'monitor', monitorId: '1' }),
      entry({ id: 'p0', type: 'persona', monitorId: '0', appId: 'chitchats', subId: 'alice' }),
      entry({ id: 'p1', type: 'persona', monitorId: '1', appId: 'chitchats', subId: 'alice' }),
    ]);

    const [m0, m1] = tree[0]!.children!;
    expect(m0!.children![0]!.children!.map((c) => c.id)).toEqual(['p0']);
    expect(m1!.children![0]!.children!.map((c) => c.id)).toEqual(['p1']);
  });

  it('holds the owner slot open when the owning app has no agent of its own', () => {
    // The ordinary case for an app that only ever talks to its personas: the iframe
    // spawns them, and no window interaction ever creates the app agent.
    const tree = buildAgentTree([
      entry({ id: 'm0', type: 'monitor', monitorId: '0' }),
      entry({ id: 'p', type: 'persona', monitorId: '0', appId: 'chitchats', subId: 'alice' }),
    ]);

    const appSlot = tree[0]!.children![0]!;
    expect(appSlot).toMatchObject({ id: null, type: 'app', label: 'chitchats (monitor 0)' });
    expect(appSlot.children!.map((c) => c.id)).toEqual(['p']);
  });

  it('holds the monitor slot open too, and roots the forest when there is no session agent', () => {
    const tree = buildAgentTree([
      entry({ id: 'a', type: 'app', monitorId: '2', appId: 'storage' }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: null, type: 'monitor', label: 'monitor 2' });
    expect(tree[0]!.children![0]!.id).toBe('a');
  });

  it('places ephemerals at the top — monitor-tier helpers keyed by nothing', () => {
    const tree = buildAgentTree([
      entry({ id: 's', type: 'session' }),
      entry({ id: 'e', type: 'ephemeral', label: 'monitor-msg-1' }),
    ]);

    expect(tree[0]!.children!.map((c) => c.id)).toEqual(['e']);
  });

  it('places the session at the root even when it is not first in the roster', () => {
    const tree = buildAgentTree([
      entry({ id: 'm0', type: 'monitor', monitorId: '0' }),
      entry({ id: 's', type: 'session' }),
    ]);

    expect(tree.map((n) => n.id)).toEqual(['s']);
    expect(tree[0]!.children!.map((n) => n.id)).toEqual(['m0']);
  });
});
