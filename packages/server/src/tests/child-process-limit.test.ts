/**
 * Android's phantom-process killer, and the monitor cap it puts on a session.
 *
 * The killer SIGKILLs Termux's children without a log line, so the server cannot see it
 * happen — only read the setting that allows it. These pin what each reading means and
 * that the cap reaches the one place monitors are minted.
 */
import { describe, it, expect } from 'bun:test';
import { MAX_MONITORS, ServerEventType, type ServerEvent } from '@yaar/shared';
import { classifyRestrictions } from '../features/android/child-process-limit.js';
import { MonitorRegistry } from '../session/monitor-registry.js';

describe('classifyRestrictions', () => {
  it('reads the toggle turned on (flag override false) as disabled', () => {
    expect(classifyRestrictions('36', 'false')).toBe('disabled');
  });

  it("reads an unset flag as Android's default, which is restricted", () => {
    expect(classifyRestrictions('34', '')).toBe('enabled');
    expect(classifyRestrictions('34', 'true')).toBe('enabled');
  });

  it('has nothing to restrict before Android 12', () => {
    expect(classifyRestrictions('30', '')).toBe('not-applicable');
  });

  it('does not guess when getprop did not answer', () => {
    expect(classifyRestrictions(null, null)).toBe('unknown');
    expect(classifyRestrictions('34', null)).toBe('unknown');
  });
});

function registry(maxMonitors: () => number) {
  const sent: ServerEvent[] = [];
  const broadcast: ServerEvent[] = [];
  const reg = new MonitorRegistry({
    sessionId: 'sess' as never,
    broadcast: (e) => broadcast.push(e),
    sendTo: (_c, e) => sent.push(e),
    subscribeConnection: () => {},
    connectionMonitor: () => undefined,
    unsubscribeMonitor: () => {},
    isCompanion: () => false,
    setViewport: () => {},
    setFormFactor: () => {},
    clearLayout: () => {},
    removeMonitorAgent: () => {},
    maxMonitors,
  });
  return { reg, sent, broadcast };
}

describe('MonitorRegistry cap', () => {
  it('refuses a monitor past a lowered cap and tells the tab why', () => {
    const { reg, sent } = registry(() => 2);
    reg.add('tab');
    expect(reg.list()).toHaveLength(2);
    sent.length = 0;

    reg.add('tab');
    expect(reg.list()).toHaveLength(2);
    const error = sent.find((e) => e.type === ServerEventType.ERROR);
    expect(error && 'error' in error ? error.error : '').toContain('child process restrictions');
    const monitors = sent.find((e) => e.type === ServerEventType.MONITORS);
    expect(monitors && 'maxMonitors' in monitors ? monitors.maxMonitors : null).toBe(2);
  });

  it('keeps monitors that exist when the cap drops, and stops only new ones', () => {
    let cap = MAX_MONITORS;
    const { reg } = registry(() => cap);
    reg.add('tab');
    reg.add('tab');
    expect(reg.list()).toHaveLength(3);

    cap = 2;
    reg.add('tab');
    expect(reg.list()).toHaveLength(3);
  });

  it('carries the cap on every MONITORS event', () => {
    const { reg, broadcast } = registry(() => 3);
    reg.add('tab');
    const last = broadcast.at(-1);
    expect(last && 'maxMonitors' in last ? last.maxMonitors : null).toBe(3);
  });
});
