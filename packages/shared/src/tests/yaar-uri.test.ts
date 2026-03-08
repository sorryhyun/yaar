import { describe, it, expect } from 'vitest';
import {
  parseYaarUri,
  parseWindowUri,
  buildWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
  parseBareWindowUri,
  isBareWindowsAuthority,
  parseConfigUri,
  buildConfigUri,
  parseBrowserUri,
  buildBrowserUri,
  parseAgentUri,
  buildAgentUri,
  parseUserUri,
  buildUserUri,
  parseSessionUri,
  buildSessionUri,
} from '../yaar-uri.js';

describe('parseWindowUri', () => {
  it('parses basic window URI', () => {
    expect(parseWindowUri('yaar://monitors/0/win-storage')).toEqual({
      monitorId: '0',
      windowId: 'win-storage',
      subPath: undefined,
    });
  });

  it('parses window URI with sub-path', () => {
    expect(parseWindowUri('yaar://monitors/0/win-excel/state/cells')).toEqual({
      monitorId: '0',
      windowId: 'win-excel',
      subPath: 'state/cells',
    });
  });

  it('parses window URI with deep sub-path', () => {
    expect(parseWindowUri('yaar://monitors/1/win-app/commands/save')).toEqual({
      monitorId: '1',
      windowId: 'win-app',
      subPath: 'commands/save',
    });
  });

  it('returns null for non-yaar URIs', () => {
    expect(parseWindowUri('https://example.com')).toBeNull();
  });

  it('returns null for content URIs', () => {
    expect(parseWindowUri('yaar://apps/excel-lite')).toBeNull();
  });
});

describe('buildWindowUri', () => {
  it('builds a window URI', () => {
    expect(buildWindowUri('0', 'win-storage')).toBe('yaar://monitors/0/win-storage');
  });
});

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

// ============ Bare Window URIs (yaar://windows/) ============

describe('parseBareWindowUri', () => {
  it('parses basic bare window URI', () => {
    expect(parseBareWindowUri('yaar://windows/my-win')).toEqual({
      windowId: 'my-win',
      subPath: undefined,
    });
  });

  it('parses bare window URI with sub-path', () => {
    expect(parseBareWindowUri('yaar://windows/my-win/state/cells')).toEqual({
      windowId: 'my-win',
      subPath: 'state/cells',
    });
  });

  it('parses bare yaar://windows/ as monitor-level (empty windowId)', () => {
    expect(parseBareWindowUri('yaar://windows/')).toEqual({
      windowId: '',
    });
  });

  it('returns null for non-windows URI', () => {
    expect(parseBareWindowUri('yaar://monitors/0/win-id')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseBareWindowUri('https://example.com')).toBeNull();
  });
});

describe('isBareWindowsAuthority', () => {
  it('returns true for yaar://windows/ URIs', () => {
    expect(isBareWindowsAuthority('yaar://windows/my-win')).toBe(true);
    expect(isBareWindowsAuthority('yaar://windows/')).toBe(true);
  });

  it('returns false for yaar://monitors/ URIs', () => {
    expect(isBareWindowsAuthority('yaar://monitors/0/win-id')).toBe(false);
  });

  it('returns false for non-yaar URIs', () => {
    expect(isBareWindowsAuthority('https://example.com')).toBe(false);
  });
});

// ============ parseYaarUri with new authorities ============

describe('parseYaarUri with config/browser', () => {
  it('parses config URIs', () => {
    expect(parseYaarUri('yaar://config/settings')).toEqual({
      authority: 'config',
      path: 'settings',
    });
  });

  it('parses browser URIs', () => {
    expect(parseYaarUri('yaar://browser/0')).toEqual({
      authority: 'browser',
      path: '0',
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

// ============ Browser URIs ============

describe('parseBrowserUri', () => {
  it('parses numeric browser ID', () => {
    expect(parseBrowserUri('yaar://browser/0')).toEqual({
      resource: '0',
      subResource: undefined,
    });
  });

  it('parses browser ID with sub-resource', () => {
    expect(parseBrowserUri('yaar://browser/1/screenshot')).toEqual({
      resource: '1',
      subResource: 'screenshot',
    });
  });

  it('parses browser ID with content sub-resource', () => {
    expect(parseBrowserUri('yaar://browser/0/content')).toEqual({
      resource: '0',
      subResource: 'content',
    });
  });

  it('parses browser ID with navigate sub-resource', () => {
    expect(parseBrowserUri('yaar://browser/2/navigate')).toEqual({
      resource: '2',
      subResource: 'navigate',
    });
  });

  it('returns null for empty resource', () => {
    expect(parseBrowserUri('yaar://browser/')).toBeNull();
  });

  it('returns null for non-browser URI', () => {
    expect(parseBrowserUri('yaar://apps/browser')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseBrowserUri('https://example.com')).toBeNull();
  });
});

describe('buildBrowserUri', () => {
  it('builds browser URI with numeric ID', () => {
    expect(buildBrowserUri('0')).toBe('yaar://browser/0');
  });

  it('builds browser URI with sub-resource', () => {
    expect(buildBrowserUri('1', 'screenshot')).toBe('yaar://browser/1/screenshot');
  });

  it('roundtrips with parseBrowserUri', () => {
    const uri = buildBrowserUri('2', 'navigate');
    const parsed = parseBrowserUri(uri);
    expect(parsed).toEqual({ resource: '2', subResource: 'navigate' });
  });
});

// ============ Agent URIs ============

describe('parseAgentUri', () => {
  it('parses list all agents', () => {
    expect(parseAgentUri('yaar://agents/')).toEqual({});
  });

  it('parses agent by instance ID', () => {
    expect(parseAgentUri('yaar://agents/agent-123')).toEqual({
      id: 'agent-123',
    });
  });

  it('parses agent with action', () => {
    expect(parseAgentUri('yaar://agents/agent-123/interrupt')).toEqual({
      id: 'agent-123',
      action: 'interrupt',
    });
  });

  it('returns null for empty ID segment', () => {
    expect(parseAgentUri('yaar://agents//interrupt')).toBeNull();
  });

  it('returns null for non-agents URI', () => {
    expect(parseAgentUri('yaar://apps/excel')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseAgentUri('https://example.com')).toBeNull();
  });
});

describe('buildAgentUri', () => {
  it('builds list URI', () => {
    expect(buildAgentUri()).toBe('yaar://agents/');
  });

  it('builds agent by ID URI', () => {
    expect(buildAgentUri('agent-123')).toBe('yaar://agents/agent-123');
  });

  it('builds agent with action URI', () => {
    expect(buildAgentUri('agent-123', 'interrupt')).toBe('yaar://agents/agent-123/interrupt');
  });

  it('roundtrips with parseAgentUri', () => {
    const uri = buildAgentUri('agent-1');
    const parsed = parseAgentUri(uri);
    expect(parsed).toEqual({ id: 'agent-1' });
  });
});

// ============ User URIs ============

describe('parseUserUri', () => {
  it('parses notifications', () => {
    expect(parseUserUri('yaar://user/notifications')).toEqual({
      resource: 'notifications',
      id: undefined,
    });
  });

  it('parses notification with ID', () => {
    expect(parseUserUri('yaar://user/notifications/abc')).toEqual({
      resource: 'notifications',
      id: 'abc',
    });
  });

  it('parses prompts', () => {
    expect(parseUserUri('yaar://user/prompts')).toEqual({
      resource: 'prompts',
      id: undefined,
    });
  });

  it('parses prompt with ID', () => {
    expect(parseUserUri('yaar://user/prompts/prompt-1')).toEqual({
      resource: 'prompts',
      id: 'prompt-1',
    });
  });

  it('parses clipboard', () => {
    expect(parseUserUri('yaar://user/clipboard')).toEqual({
      resource: 'clipboard',
      id: undefined,
    });
  });

  it('returns null for unknown resource', () => {
    expect(parseUserUri('yaar://user/unknown')).toBeNull();
  });

  it('returns null for non-user URI', () => {
    expect(parseUserUri('yaar://apps/user')).toBeNull();
  });

  it('returns null for non-yaar URI', () => {
    expect(parseUserUri('https://example.com')).toBeNull();
  });
});

describe('buildUserUri', () => {
  it('builds notifications URI', () => {
    expect(buildUserUri('notifications')).toBe('yaar://user/notifications');
  });

  it('builds notification with ID URI', () => {
    expect(buildUserUri('notifications', 'abc')).toBe('yaar://user/notifications/abc');
  });

  it('builds clipboard URI', () => {
    expect(buildUserUri('clipboard')).toBe('yaar://user/clipboard');
  });

  it('roundtrips with parseUserUri', () => {
    const uri = buildUserUri('prompts', 'prompt-42');
    const parsed = parseUserUri(uri);
    expect(parsed).toEqual({ resource: 'prompts', id: 'prompt-42' });
  });
});

// ============ Session URIs ============

describe('parseSessionUri', () => {
  it('parses current session', () => {
    expect(parseSessionUri('yaar://sessions/current')).toEqual({
      resource: 'current',
      subResource: undefined,
    });
  });

  it('parses current session logs', () => {
    expect(parseSessionUri('yaar://sessions/current/logs')).toEqual({
      resource: 'current',
      subResource: 'logs',
    });
  });

  it('parses current session context', () => {
    expect(parseSessionUri('yaar://sessions/current/context')).toEqual({
      resource: 'current',
      subResource: 'context',
    });
  });

  it('returns null for unknown resource', () => {
    expect(parseSessionUri('yaar://sessions/unknown')).toBeNull();
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

  it('builds current session logs URI', () => {
    expect(buildSessionUri('current', 'logs')).toBe('yaar://sessions/current/logs');
  });

  it('builds current session context URI', () => {
    expect(buildSessionUri('current', 'context')).toBe('yaar://sessions/current/context');
  });

  it('roundtrips with parseSessionUri', () => {
    const uri = buildSessionUri('current', 'logs');
    const parsed = parseSessionUri(uri);
    expect(parsed).toEqual({ resource: 'current', subResource: 'logs' });
  });
});

// ============ parseYaarUri with new authorities ============

describe('parseYaarUri with windows', () => {
  it('parses windows URIs', () => {
    expect(parseYaarUri('yaar://windows/my-win')).toEqual({
      authority: 'windows',
      path: 'my-win',
    });
  });

  it('parses bare windows URI', () => {
    expect(parseYaarUri('yaar://windows/')).toEqual({
      authority: 'windows',
      path: '',
    });
  });
});

describe('parseYaarUri with agents/user/sessions', () => {
  it('parses agents URIs', () => {
    expect(parseYaarUri('yaar://agents/agent-123')).toEqual({
      authority: 'agents',
      path: 'agent-123',
    });
  });

  it('parses user URIs', () => {
    expect(parseYaarUri('yaar://user/notifications')).toEqual({
      authority: 'user',
      path: 'notifications',
    });
  });

  it('parses sessions URIs', () => {
    expect(parseYaarUri('yaar://sessions/current')).toEqual({
      authority: 'sessions',
      path: 'current',
    });
  });
});
