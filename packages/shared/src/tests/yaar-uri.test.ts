import { describe, it, expect } from 'bun:test';
import { parseYaarUri, parseBareWindowUri, isBareWindowsAuthority } from '../yaar-uri.js';

// ============ Window URIs (yaar://windows/) ============

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

  it('returns null for non-yaar URI', () => {
    expect(parseBareWindowUri('https://example.com')).toBeNull();
  });
});

describe('isBareWindowsAuthority', () => {
  it('returns true for yaar://windows/ URIs', () => {
    expect(isBareWindowsAuthority('yaar://windows/my-win')).toBe(true);
    expect(isBareWindowsAuthority('yaar://windows/')).toBe(true);
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

describe('parseYaarUri with session', () => {
  it('parses session URIs', () => {
    expect(parseYaarUri('yaar://session/')).toEqual({
      authority: 'session',
      path: '',
    });
  });

  it('parses session URIs with deep paths', () => {
    expect(parseYaarUri('yaar://session/agents/agent-123')).toEqual({
      authority: 'session',
      path: 'agents/agent-123',
    });
  });

  it('returns null for removed agents authority', () => {
    expect(parseYaarUri('yaar://agents/agent-123')).toBeNull();
  });

  it('returns null for removed user authority', () => {
    expect(parseYaarUri('yaar://user/notifications')).toBeNull();
  });

  it('returns null for removed monitors authority', () => {
    expect(parseYaarUri('yaar://monitors/0/win-id')).toBeNull();
  });
});
