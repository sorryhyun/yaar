import { describe, test, expect } from '@bundled/test';
import {
  annotateMonitors,
  monitorsFromMeta,
  normalizeMonitor,
  resolveMonitor,
  metaWindowMonitors,
} from './monitor';
import { indexSession, selectTurns, countByMonitor } from './select';
import type { ParsedMessage } from './types';
import { ALL, annotateEpochs, conversationsOf, epochCounts } from './conversations';

const msg = (p: Partial<ParsedMessage>): ParsedMessage => ({
  type: 'assistant',
  timestamp: '2026-10-09T14:10:00Z',
  agentId: null,
  ...p,
});

const meta = {
  threadIds: { 'monitor-0': 't0', 'monitor-1': 't1' },
  agents: [
    { agentId: 'monitor-0', windowId: null },
    { agentId: 'devtools-agent', windowId: '2/devtools' },
  ],
};

describe('resolveMonitor', () => {
  const windows = metaWindowMonitors(meta);
  test('source wins over the agent id', () => {
    expect(
      resolveMonitor(msg({ source: 'yaar://monitors/1', agentId: 'monitor-0' }), windows),
    ).toBe('1');
  });
  test('monitor-N agent ids in every spelling', () => {
    for (const id of [
      'monitor-3',
      'monitor-3-msg-abc',
      'monitor-3-dm-x',
      'monitor-3-hook-resp-9',
    ]) {
      expect(resolveMonitor(msg({ agentId: id }), windows)).toBe('3');
    }
  });
  test('app agents by -mN-', () => {
    expect(resolveMonitor(msg({ agentId: 'app-devtools-m1-agent-msg-17' }), windows)).toBe('1');
  });
  test('parentAgentId, then meta windowId', () => {
    expect(resolveMonitor(msg({ agentId: 'x', parentAgentId: 'monitor-4' }), windows)).toBe('4');
    expect(resolveMonitor(msg({ agentId: 'devtools-agent' }), windows)).toBe('2');
  });
  test("an agent-less row's own monitorId, then its windowId", () => {
    const verb = { type: 'tool_use' as const, toolName: 'iframe:devtools' };
    expect(resolveMonitor(msg({ ...verb, monitorId: '1', windowId: '0/x' }), windows)).toBe('1');
    expect(resolveMonitor(msg({ ...verb, windowId: '3/devtools' }), windows)).toBe('3');
  });
  test("meta monitorId over the agent's window", () => {
    const w = metaWindowMonitors({
      agents: { a: { agentId: 'a', windowId: '0/devtools', monitorId: '5' } },
    });
    expect(resolveMonitor(msg({ agentId: 'a' }), w)).toBe('5');
    expect(monitorsFromMeta({ agents: { 'monitor-1': { monitorId: '1' } } })).toEqual(['1']);
  });
  test('nothing to go on', () => {
    expect(resolveMonitor(msg({ agentId: 'mystery' }), windows)).toBe(null);
  });
  test('an agent-less window.create lands on its window id’s monitor', () => {
    const create = msg({
      type: 'action',
      action: { type: 'window.create', windowId: '2/session-logs' },
    });
    expect(resolveMonitor(create, windows)).toBe('2');
  });
});

describe('annotateMonitors', () => {
  test('an unplaced turn inherits its agent, else unknown', () => {
    const list = [
      msg({ agentId: 'solo', source: 'yaar://monitors/1' }),
      msg({ agentId: 'solo' }),
      msg({ agentId: null }),
    ];
    annotateMonitors(list, null);
    expect(list.map((m) => m.monitor)).toEqual(['1', '1', 'unknown']);
  });
});

describe('monitorsFromMeta', () => {
  test('reads the recorded monitor list', () => {
    expect(monitorsFromMeta({ monitors: ['0', '2'] })).toEqual(['0', '2']);
  });
  test('threadIds keys plus agents, sorted', () => {
    expect(monitorsFromMeta(meta)).toEqual(['0', '1', '2']);
  });
  test('agents as a map, missing fields', () => {
    expect(monitorsFromMeta({ agents: { 'app-x-m5-agent': {} } })).toEqual(['5']);
    expect(monitorsFromMeta({})).toEqual([]);
    expect(monitorsFromMeta(null)).toEqual([]);
  });
});

describe('normalizeMonitor', () => {
  test('spellings', () => {
    expect(normalizeMonitor(1)).toBe('1');
    expect(normalizeMonitor('monitor-1')).toBe('1');
    expect(normalizeMonitor('M2')).toBe('2');
    expect(normalizeMonitor('all')).toBe(null);
    expect(normalizeMonitor(undefined)).toBe(null);
    expect(normalizeMonitor('unknown')).toBe('unknown');
  });
});

describe('restored + monitor filtering', () => {
  const list = annotateMonitors(
    [
      msg({ agentId: 'monitor-0', restored: true }),
      msg({ agentId: 'monitor-0' }),
      msg({ agentId: 'monitor-1', isError: true }),
      msg({ agentId: 'app-lab-m1-agent' }),
    ],
    null,
  );
  test('readTurns default skips restored, keeps full-log index', () => {
    expect(selectTurns(list).map((t) => t.index)).toEqual([1, 2, 3]);
    expect(selectTurns(list, { includeRestored: true }).length).toBe(4);
    expect(selectTurns(list, { monitor: '1' }).map((t) => t.index)).toEqual([2, 3]);
  });
  test('index excludes restored and groups app agents under their monitor', () => {
    const idx = indexSession(list) as Record<string, any>;
    expect(idx.total).toBe(3);
    expect(idx.restored).toEqual({ count: 1, included: false });
    expect(idx.byMonitor.map((m: any) => [m.monitor, m.turns, m.errors])).toEqual([
      ['0', 1, 0],
      ['1', 2, 1],
    ]);
    expect(idx.byMonitor[1].agents.map((a: any) => a.name).sort()).toEqual([
      'app-lab-m1-agent',
      'monitor-1',
    ]);
    expect((indexSession(list, { includeRestored: true }) as any).total).toBe(4);
  });
  test('countByMonitor honours the toggle', () => {
    expect(countByMonitor(list, false)).toEqual([
      { monitor: '0', turns: 1 },
      { monitor: '1', turns: 2 },
    ]);
    expect(countByMonitor(list, true)[0]).toEqual({ monitor: '0', turns: 2 });
  });
});

describe('conversations', () => {
  const summary = {
    sessionId: 's1',
    createdAt: '2026-10-11T10:00:00Z',
    lastActivity: '2026-10-11T12:00:00Z',
    provider: 'claude',
    agentCount: 3,
    monitors: ['1', '0'],
    resets: [
      { at: '2026-10-11T10:30:00Z', monitorIds: ['0'] },
      { at: '2026-10-11T11:00:00Z', monitorIds: ['0', '1'] },
    ],
  };

  test('a row per monitor per reset that named it', () => {
    const rows = conversationsOf(summary);
    expect(rows.map((c) => `${c.monitor}.${c.epoch}/${c.count}`)).toEqual([
      '0.0/3',
      '0.1/3',
      '0.2/3',
      '1.0/2',
      '1.1/2',
    ]);
    const m0 = rows.filter((c) => c.monitor === '0');
    expect(m0.map((c) => [c.start, c.end])).toEqual([
      ['2026-10-11T10:00:00Z', '2026-10-11T10:30:00Z'],
      ['2026-10-11T10:30:00Z', '2026-10-11T11:00:00Z'],
      ['2026-10-11T11:00:00Z', '2026-10-11T12:00:00Z'],
    ]);
    expect(rows.filter((c) => c.latest).map((c) => c.key)).toEqual(['s1|0|2', 's1|1|1']);
  });

  test('a log with no monitor list is one whole-log row', () => {
    const rows = conversationsOf({ ...summary, monitors: undefined, resets: undefined });
    expect(rows.map((c) => [c.monitor, c.epoch])).toEqual([[ALL, 0]]);
  });

  test('turns land in the conversation their monitor was in, and the filter agrees', () => {
    const messages = annotateEpochs(
      annotateMonitors(
        [
          msg({ type: 'user', source: 'yaar://monitors/0', content: 'zero, first' }),
          msg({ type: 'user', source: 'yaar://monitors/1', content: 'one, first' }),
          msg({ type: 'reset', monitorIds: ['0'] }),
          msg({ type: 'user', source: 'yaar://monitors/0', content: 'zero, second' }),
          msg({ type: 'user', source: 'yaar://monitors/1', content: 'one, still first' }),
          msg({ type: 'interaction', interaction: 'click' }),
        ],
        null,
      ),
    );
    const contents = (monitor: string, conversation: number | null) =>
      selectTurns(messages, { monitor, conversation }).map((t) => t.msg.content ?? t.msg.type);

    expect(contents('0', 0)).toEqual(['zero, first']);
    // An unplaced turn counts toward monitor 0.
    expect(contents('0', 1)).toEqual(['zero, second', 'interaction']);
    expect(contents('1', 0)).toEqual(['one, first', 'one, still first']);
    expect(contents('1', null)).toEqual(['one, first', 'one, still first']);
    // The reset itself is only in the whole-log view.
    expect(selectTurns(messages, {}).some((t) => t.msg.type === 'reset')).toBe(true);
    expect(Object.fromEntries(epochCounts(messages))).toEqual({ '0': 2, '1': 1 });
  });
});
