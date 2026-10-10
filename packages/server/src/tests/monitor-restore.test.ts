/**
 * A restart reopens the monitors the session had.
 *
 * `MonitorRegistry` used to start with monitor 0 alone, so shutting down with three
 * desktops came back with one: the windows restored onto monitors 1 and 2 had no desktop
 * to render on, and their context and provider threads waited on a monitor nobody could
 * reach.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { MonitorRegistry, type MonitorRegistryDeps } from '../session/monitor-registry.js';
import { restoredMonitorIds } from '../logging/restore-source.js';
import type { SessionInfo, SessionMetadata } from '../logging/types.js';

function registry(extra: Partial<MonitorRegistryDeps> = {}) {
  const broadcasts: unknown[] = [];
  const reg = new MonitorRegistry({
    sessionId: 'sess' as never,
    broadcast: (e) => broadcasts.push(e),
    sendTo: () => {},
    subscribeConnection: () => {},
    connectionMonitor: () => undefined,
    unsubscribeMonitor: () => {},
    isCompanion: () => false,
    setViewport: () => {},
    setFormFactor: () => {},
    setOrientation: () => {},
    clearLayout: () => {},
    removeMonitorAgent: () => {},
    ...extra,
  });
  return { reg, broadcasts };
}

function session(metadata: Partial<SessionMetadata>): SessionInfo {
  return {
    sessionId: 'prev',
    directory: '/nowhere',
    metadata: { createdAt: '', provider: 'claude', lastActivity: '', agents: {}, ...metadata },
  };
}

const create = (windowId: string): OSAction =>
  ({
    type: 'window.create',
    windowId,
    title: windowId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'markdown', data: '' },
  }) as OSAction;

describe('restoredMonitorIds', () => {
  it('reads the recorded list, without monitor 0', () => {
    expect(restoredMonitorIds(session({ monitors: ['0', '2', '1'] }), [])).toEqual(['1', '2']);
  });

  it('trusts the recorded list over where windows sit — a removed monitor stays removed', () => {
    expect(restoredMonitorIds(session({ monitors: ['0'] }), [create('2/notes')])).toEqual([]);
  });

  it('falls back to the monitors with an open window in a log that recorded no list', () => {
    const actions = [create('0/dock'), create('2/notes'), create('2/memo'), create('crawl')];
    expect(restoredMonitorIds(session({}), actions)).toEqual(['2']);
  });
});

describe('MonitorRegistry restored monitors', () => {
  it('starts with monitor 0 plus the restored ones', () => {
    const { reg } = registry({ restored: ['2', '1'] });
    expect(reg.list()).toEqual([
      { id: '0', label: 'Monitor 1' },
      { id: '2', label: 'Monitor 3' },
      { id: '1', label: 'Monitor 2' },
    ]);
  });

  it('drops restored monitors past the cap', () => {
    const { reg } = registry({ restored: ['1', '2', '3'], maxMonitors: () => 2 });
    expect(reg.ids()).toEqual(['0', '1']);
  });

  it('mints into the gaps the restored ids leave', () => {
    const { reg } = registry({ restored: ['2'] });
    reg.add('tab');
    expect(reg.ids()).toEqual(['0', '2', '1']);
  });

  it('reports every change to the list', async () => {
    const changes: string[][] = [];
    const { reg } = registry({ restored: ['1'], onChange: (ids) => changes.push(ids) });
    reg.add('tab');
    await reg.remove('1');
    expect(changes).toEqual([
      ['0', '1', '2'],
      ['0', '2'],
    ]);
  });
});
