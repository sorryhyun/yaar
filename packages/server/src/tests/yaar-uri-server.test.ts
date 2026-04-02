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
    expect(buildWindowResourceUri('win-excel', 'state', 'cells')).toBe(
      'yaar://windows/win-excel/state/cells',
    );
  });

  it('builds a commands URI', () => {
    expect(buildWindowResourceUri('win-excel', 'commands', 'save')).toBe(
      'yaar://windows/win-excel/commands/save',
    );
  });
});

describe('parseWindowResourceUri', () => {
  it('parses a state resource URI', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel/state/cells')).toEqual({
      windowId: 'win-excel',
      resourceType: 'state',
      key: 'cells',
    });
  });

  it('parses a commands resource URI', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel/commands/save')).toEqual({
      windowId: 'win-excel',
      resourceType: 'commands',
      key: 'save',
    });
  });

  it('returns null for bare window URI (no sub-path)', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel')).toBeNull();
  });

  it('returns null for unknown resource type', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel/unknown/key')).toBeNull();
  });

  it('returns null for sub-path without key', () => {
    expect(parseWindowResourceUri('yaar://windows/win-excel/state')).toBeNull();
  });

  it('roundtrips with buildWindowResourceUri', () => {
    const uri = buildWindowResourceUri('win-app', 'commands', 'refresh');
    const parsed = parseWindowResourceUri(uri);
    expect(parsed).toEqual({
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
    expect(parseSessionUri('yaar://session/')).toEqual({});
  });

  it('parses agents list', () => {
    expect(parseSessionUri('yaar://session/agents')).toEqual({
      subKind: 'agents',
    });
  });

  it('parses agent by ID', () => {
    expect(parseSessionUri('yaar://session/agents/agent-123')).toEqual({
      subKind: 'agents',
      id: 'agent-123',
    });
  });

  it('parses agent with action', () => {
    expect(parseSessionUri('yaar://session/agents/agent-123/interrupt')).toEqual({
      subKind: 'agents',
      id: 'agent-123',
      action: 'interrupt',
    });
  });

  it('parses notifications', () => {
    expect(parseSessionUri('yaar://session/notifications')).toEqual({
      subKind: 'notifications',
    });
  });

  it('parses notification with ID', () => {
    expect(parseSessionUri('yaar://session/notifications/abc')).toEqual({
      subKind: 'notifications',
      id: 'abc',
    });
  });

  it('parses prompts', () => {
    expect(parseSessionUri('yaar://session/prompts')).toEqual({
      subKind: 'prompts',
    });
  });

  it('parses clipboard', () => {
    expect(parseSessionUri('yaar://session/clipboard')).toEqual({
      subKind: 'clipboard',
    });
  });

  it('parses monitor by ID', () => {
    expect(parseSessionUri('yaar://session/monitors/0')).toEqual({
      subKind: 'monitors',
      id: '0',
    });
  });

  it('returns null for unknown subKind', () => {
    expect(parseSessionUri('yaar://session/unknown')).toBeNull();
  });

  it('returns null for non-session URI', () => {
    expect(parseSessionUri('yaar://apps/sessions')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseSessionUri('https://example.com')).toBeNull();
  });
});

describe('buildSessionUri', () => {
  it('builds current session URI', () => {
    expect(buildSessionUri()).toBe('yaar://session/');
  });

  it('builds agents list URI', () => {
    expect(buildSessionUri('agents')).toBe('yaar://session/agents');
  });

  it('builds agent by ID URI', () => {
    expect(buildSessionUri('agents', 'agent-123')).toBe('yaar://session/agents/agent-123');
  });

  it('builds agent with action URI', () => {
    expect(buildSessionUri('agents', 'agent-123', 'interrupt')).toBe(
      'yaar://session/agents/agent-123/interrupt',
    );
  });

  it('builds notifications URI', () => {
    expect(buildSessionUri('notifications')).toBe('yaar://session/notifications');
  });

  it('builds notification with ID URI', () => {
    expect(buildSessionUri('notifications', 'abc')).toBe('yaar://session/notifications/abc');
  });

  it('builds clipboard URI', () => {
    expect(buildSessionUri('clipboard')).toBe('yaar://session/clipboard');
  });

  it('builds monitor URI', () => {
    expect(buildSessionUri('monitors', '0')).toBe('yaar://session/monitors/0');
  });

  it('roundtrips agents with parseSessionUri', () => {
    const uri = buildSessionUri('agents', 'agent-1');
    const parsed = parseSessionUri(uri);
    expect(parsed).toEqual({ subKind: 'agents', id: 'agent-1' });
  });

  it('roundtrips notifications with parseSessionUri', () => {
    const uri = buildSessionUri('notifications', 'notif-42');
    const parsed = parseSessionUri(uri);
    expect(parsed).toEqual({ subKind: 'notifications', id: 'notif-42' });
  });
});
