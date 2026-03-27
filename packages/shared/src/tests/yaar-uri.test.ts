import { describe, it, expect } from 'bun:test';
import {
  parseYaarUri,
  parseWindowUri,
  buildWindowUri,
  parseBareWindowUri,
  isBareWindowsAuthority,
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

// ============ parseYaarUri with authorities ============

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

describe('parseYaarUri with sessions', () => {
  it('parses sessions URIs', () => {
    expect(parseYaarUri('yaar://sessions/current')).toEqual({
      authority: 'sessions',
      path: 'current',
    });
  });

  it('parses sessions URIs with deep paths', () => {
    expect(parseYaarUri('yaar://sessions/current/agents/agent-123')).toEqual({
      authority: 'sessions',
      path: 'current/agents/agent-123',
    });
  });

  it('returns null for removed agents authority', () => {
    expect(parseYaarUri('yaar://agents/agent-123')).toBeNull();
  });

  it('returns null for removed user authority', () => {
    expect(parseYaarUri('yaar://user/notifications')).toBeNull();
  });
});
