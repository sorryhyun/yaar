/**
 * `yaar://windows/{id}/history` — the replay log, opened to agents.
 *
 * The property that matters most is the one in the registry's own comment: the
 * replayable command list is a *view* of the history, never a second list. So a failed
 * command is in the history and not in the replay; a restore truncates both at once;
 * and closing the window drops both.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry, WINDOW_HISTORY_CAP } from '../session/window-state.js';
import {
  listHistory,
  readHistory,
  restoreHistory,
  parseHistorySubPath,
} from '../features/window/history.js';

function createIframe(id: string): OSAction {
  return {
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: { renderer: 'iframe' as const, data: 'yaar://apps/memo' },
  };
}

function text(result: { content: unknown }): string {
  return JSON.stringify(result.content);
}

describe('window history', () => {
  it('parses the history sub-path and nothing else', () => {
    expect(parseHistorySubPath('history')).toEqual({});
    expect(parseHistorySubPath('history/12')).toEqual({ seq: 12 });
    expect(parseHistorySubPath('history/x')).toBeNull();
    expect(parseHistorySubPath('state/history')).toBeNull();
  });

  it('records commands with seq, outcome and sender; only successes replay', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createIframe('memo'), '0');
    registry.recordAppCommand(
      'memo',
      { kind: 'command', command: 'add', params: { t: 1 } },
      { ok: true },
      'agent-a',
    );
    registry.recordAppCommand(
      'memo',
      { kind: 'command', command: 'boom' },
      { ok: false, error: 'nope' },
    );
    registry.recordWindowEvent('memo', 'replayed', '1 command(s)');

    const { entries, dropped } = registry.getWindowHistory('memo');
    expect(dropped).toBe(0);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0]).toMatchObject({
      kind: 'command',
      command: 'add',
      ok: true,
      agentId: 'agent-a',
    });
    expect(entries[1]).toMatchObject({
      kind: 'command',
      command: 'boom',
      ok: false,
      error: 'nope',
    });
    expect(entries[2]).toMatchObject({ kind: 'event', event: 'replayed' });

    expect(registry.getAppCommands('memo')).toEqual([
      { kind: 'command', command: 'add', params: { t: 1 } },
    ]);
  });

  it('truncates after a seq and keeps numbering monotonic', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createIframe('memo'), '0');
    for (const c of ['a', 'b', 'c'])
      registry.recordAppCommand('memo', { kind: 'command', command: c });
    const removed = registry.truncateWindowHistory('memo', 1);
    expect(removed.map((e) => e.kind === 'command' && e.command)).toEqual(['b', 'c']);
    expect(registry.getAppCommands('memo').map((r) => r.kind === 'command' && r.command)).toEqual([
      'a',
    ]);
    registry.recordAppCommand('memo', { kind: 'command', command: 'd' });
    expect(registry.getWindowHistory('memo').entries.map((e) => e.seq)).toEqual([1, 4]);
    expect(registry.truncateWindowHistory('memo', 0)).toHaveLength(2);
    expect(registry.getAppCommands('memo')).toEqual([]);
  });

  it('caps the log and names how much fell off', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createIframe('memo'), '0');
    for (let i = 0; i < WINDOW_HISTORY_CAP + 5; i++)
      registry.recordAppCommand('memo', { kind: 'command', command: `c${i}` });
    const { entries, dropped } = registry.getWindowHistory('memo');
    expect(entries).toHaveLength(WINDOW_HISTORY_CAP);
    expect(dropped).toBe(5);
    expect(entries[0]!.seq).toBe(6);
  });

  it('drops the history with the window', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createIframe('memo'), '0');
    registry.recordAppCommand('memo', { kind: 'command', command: 'a' });
    registry.handleAction({ type: 'window.close', windowId: 'memo' }, '0');
    expect(registry.getWindowHistory('memo').entries).toEqual([]);
  });

  it('answers the verbs: empty, list, read one, restore', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(createIframe('memo'), '0');
    expect(text(listHistory(registry, 'memo'))).toContain('No history');

    registry.recordAppCommand('memo', {
      kind: 'command',
      command: 'add',
      params: { text: 'hello' },
    });
    registry.recordAppCommand('memo', { kind: 'command', command: 'del', params: { id: 1 } });
    const listed = text(listHistory(registry, 'memo'));
    expect(listed).toContain('yaar://windows/memo/history/1');
    expect(listed).toContain('add({\\"text\\":\\"hello\\"})');

    const one = text(readHistory(registry, 'memo', 2));
    expect(one).toContain('\\"seq\\": 2');
    expect(one).toContain('del');
    expect(text(readHistory(registry, 'memo', 9))).toContain('No history entry 9');

    expect(text(restoreHistory(registry, 'memo', { action: 'restore' }))).toContain(
      'is required for restore',
    );
    expect(text(restoreHistory(registry, 'memo', { action: 'restore', upTo: 9 }))).toContain(
      'No history entry 9',
    );

    const restored = text(restoreHistory(registry, 'memo', { action: 'restore', upTo: 1 }));
    expect(restored).toContain('1 later entry forgotten');
    expect(restored).toContain('1 command(s) will be replayed');
    const { entries } = registry.getWindowHistory('memo');
    expect(entries.map((e) => e.kind)).toEqual(['command', 'event']);
    expect(entries[1]).toMatchObject({ event: 'restored' });
    expect(registry.getAppCommands('memo')).toHaveLength(1);
  });

  it('refuses restore on a non-app window', () => {
    const registry = new WindowStateRegistry();
    registry.handleAction(
      {
        type: 'window.create',
        windowId: 'doc',
        title: 'doc',
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        content: { renderer: 'markdown' as const, data: '' },
      },
      '0',
    );
    expect(text(restoreHistory(registry, 'doc', { action: 'restore', upTo: 0 }))).toContain(
      'not an app window',
    );
  });
});
