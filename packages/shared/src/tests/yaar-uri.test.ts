import { describe, it, expect } from 'vitest';
import {
  parseYaarUri,
  parseWindowUri,
  buildWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
  parseConfigUri,
  buildConfigUri,
  parseBrowserUri,
  buildBrowserUri,
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
