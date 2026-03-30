import { describe, it, expect } from 'bun:test';
import {
  buildWindowResourceUri,
  parseWindowResourceUri,
  parseConfigUri,
  buildConfigUri,
  parseSessionUri,
  buildSessionUri,
} from '../lib/yaar-uri-server.js';

// ============ Window Resource URIs ============

describe('buildWindowResourceUri', () => {
  it('builds a state URI', () => {
    expect(buildWindowResourceUri('0', 'win-excel', 'state', 'cells')).toBe(
      'yaar://monitors/0/win-excel/state/cells',
    );
  });

  it('builds a commands URI', () => {
    expect(buildWindowResourceUri('0', 'win-excel', 'commands', 'save')).toBe(
      'yaar://monitors/0/win-excel/commands/save',
    );
  });
});

describe('parseWindowResourceUri', () => {
  it('parses a state resource URI', () => {
    expect(parseWindowResourceUri('yaar://monitors/0/win-excel/state/cells')).toEqual({
      monitorId: '0',
      windowId: 'win-excel',
      resourceType: 'state',
      key: 'cells',
    });
  });

  it('parses a commands resource URI', () => {
    expect(parseWindowResourceUri('yaar://monitors/0/win-excel/commands/save')).toEqual({
      monitorId: '0',
      windowId: 'win-excel',
      resourceType: 'commands',
      key: 'save',
    });
  });

  it('returns null for bare window URI (no sub-path)', () => {
    expect(parseWindowResourceUri('yaar://monitors/0/win-excel')).toBeNull();
  });

  it('returns null for unknown resource type', () => {
    expect(parseWindowResourceUri('yaar://monitors/0/win-excel/unknown/key')).toBeNull();
  });

  it('returns null for sub-path without key', () => {
    expect(parseWindowResourceUri('yaar://monitors/0/win-excel/state')).toBeNull();
  });

  it('parses bare window resource URI (yaar://windows/)', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel/state/cells')).toEqual({
      monitorId: '',
      windowId: 'win-excel',
      resourceType: 'state',
      key: 'cells',
    });
  });

  it('parses bare window commands URI', () => {
    expect(parseWindowResourceUri('yaar://windows/win-app/commands/save')).toEqual({
      monitorId: '',
      windowId: 'win-app',
      resourceType: 'commands',
      key: 'save',
    });
  });

  it('roundtrips with buildWindowResourceUri', () => {
    const uri = buildWindowResourceUri('1', 'win-app', 'commands', 'refresh');
    const parsed = parseWindowResourceUri(uri);
    expect(parsed).toEqual({
      monitorId: '1',
      windowId: 'win-app',
      resourceType: 'commands',
      key: 'refresh',
    });
  });
});

// ============ Config URIs ============

describe('parseConfigUri', () => {
  it('parses settings section', () => {
    expect(parseConfigUri('yaar://config/settings')).toEqual({
      section: 'settings',
      id: undefined,
    });
  });

  it('parses hooks section', () => {
    expect(parseConfigUri('yaar://config/hooks')).toEqual({
      section: 'hooks',
      id: undefined,
    });
  });

  it('parses hooks with ID', () => {
    expect(parseConfigUri('yaar://config/hooks/hook-1')).toEqual({
      section: 'hooks',
      id: 'hook-1',
    });
  });

  it('parses shortcuts section', () => {
    expect(parseConfigUri('yaar://config/shortcuts')).toEqual({
      section: 'shortcuts',
      id: undefined,
    });
  });

  it('parses shortcuts with ID', () => {
    expect(parseConfigUri('yaar://config/shortcuts/shortcut-123')).toEqual({
      section: 'shortcuts',
      id: 'shortcut-123',
    });
  });

  it('parses mounts section', () => {
    expect(parseConfigUri('yaar://config/mounts')).toEqual({
      section: 'mounts',
      id: undefined,
    });
  });

  it('parses app section with ID', () => {
    expect(parseConfigUri('yaar://config/app/github-manager')).toEqual({
      section: 'app',
      id: 'github-manager',
    });
  });

  it('returns null for unknown section', () => {
    expect(parseConfigUri('yaar://config/unknown')).toBeNull();
  });

  it('returns null for non-config URI', () => {
    expect(parseConfigUri('yaar://apps/excel-lite')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseConfigUri('https://example.com')).toBeNull();
  });
});

describe('buildConfigUri', () => {
  it('builds section URI', () => {
    expect(buildConfigUri('settings')).toBe('yaar://config/settings');
  });

  it('builds section URI with ID', () => {
    expect(buildConfigUri('hooks', 'hook-1')).toBe('yaar://config/hooks/hook-1');
  });

  it('builds app URI with ID', () => {
    expect(buildConfigUri('app', 'github')).toBe('yaar://config/app/github');
  });

  it('roundtrips with parseConfigUri', () => {
    const uri = buildConfigUri('shortcuts', 'shortcut-42');
    const parsed = parseConfigUri(uri);
    expect(parsed).toEqual({ section: 'shortcuts', id: 'shortcut-42' });
  });
});

// ============ Session URIs ============

describe('parseSessionUri', () => {
  it('parses current session', () => {
    expect(parseSessionUri('yaar://sessions/current')).toEqual({
      resource: 'current',
    });
  });

  it('parses agents list', () => {
    expect(parseSessionUri('yaar://sessions/current/agents')).toEqual({
      resource: 'current',
      subKind: 'agents',
    });
  });

  it('parses agent by ID', () => {
    expect(parseSessionUri('yaar://sessions/current/agents/agent-123')).toEqual({
      resource: 'current',
      subKind: 'agents',
      id: 'agent-123',
    });
  });

  it('parses agent with action', () => {
    expect(parseSessionUri('yaar://sessions/current/agents/agent-123/interrupt')).toEqual({
      resource: 'current',
      subKind: 'agents',
      id: 'agent-123',
      action: 'interrupt',
    });
  });

  it('parses notifications', () => {
    expect(parseSessionUri('yaar://sessions/current/notifications')).toEqual({
      resource: 'current',
      subKind: 'notifications',
    });
  });

  it('parses notification with ID', () => {
    expect(parseSessionUri('yaar://sessions/current/notifications/abc')).toEqual({
      resource: 'current',
      subKind: 'notifications',
      id: 'abc',
    });
  });

  it('parses prompts', () => {
    expect(parseSessionUri('yaar://sessions/current/prompts')).toEqual({
      resource: 'current',
      subKind: 'prompts',
    });
  });

  it('parses clipboard', () => {
    expect(parseSessionUri('yaar://sessions/current/clipboard')).toEqual({
      resource: 'current',
      subKind: 'clipboard',
    });
  });

  it('parses monitor by ID', () => {
    expect(parseSessionUri('yaar://sessions/current/monitors/0')).toEqual({
      resource: 'current',
      subKind: 'monitors',
      id: '0',
    });
  });

  it('parses non-current resource as session ID', () => {
    expect(parseSessionUri('yaar://sessions/2026-03-10_13-39-16')).toEqual({
      resource: '2026-03-10_13-39-16',
    });
  });

  it('returns null for unknown subKind', () => {
    expect(parseSessionUri('yaar://sessions/current/unknown')).toBeNull();
  });

  it('returns null for non-sessions URI', () => {
    expect(parseSessionUri('yaar://apps/sessions')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseSessionUri('https://example.com')).toBeNull();
  });
});

describe('buildSessionUri', () => {
  it('builds current session URI', () => {
    expect(buildSessionUri('current')).toBe('yaar://sessions/current');
  });

  it('builds agents list URI', () => {
    expect(buildSessionUri('current', 'agents')).toBe('yaar://sessions/current/agents');
  });

  it('builds agent by ID URI', () => {
    expect(buildSessionUri('current', 'agents', 'agent-123')).toBe(
      'yaar://sessions/current/agents/agent-123',
    );
  });

  it('builds agent with action URI', () => {
    expect(buildSessionUri('current', 'agents', 'agent-123', 'interrupt')).toBe(
      'yaar://sessions/current/agents/agent-123/interrupt',
    );
  });

  it('builds notifications URI', () => {
    expect(buildSessionUri('current', 'notifications')).toBe(
      'yaar://sessions/current/notifications',
    );
  });

  it('builds notification with ID URI', () => {
    expect(buildSessionUri('current', 'notifications', 'abc')).toBe(
      'yaar://sessions/current/notifications/abc',
    );
  });

  it('builds clipboard URI', () => {
    expect(buildSessionUri('current', 'clipboard')).toBe('yaar://sessions/current/clipboard');
  });

  it('builds monitor URI', () => {
    expect(buildSessionUri('current', 'monitors', '0')).toBe('yaar://sessions/current/monitors/0');
  });

  it('roundtrips agents with parseSessionUri', () => {
    const uri = buildSessionUri('current', 'agents', 'agent-1');
    const parsed = parseSessionUri(uri);
    expect(parsed).toEqual({ resource: 'current', subKind: 'agents', id: 'agent-1' });
  });

  it('roundtrips notifications with parseSessionUri', () => {
    const uri = buildSessionUri('current', 'notifications', 'notif-42');
    const parsed = parseSessionUri(uri);
    expect(parsed).toEqual({ resource: 'current', subKind: 'notifications', id: 'notif-42' });
  });
});
