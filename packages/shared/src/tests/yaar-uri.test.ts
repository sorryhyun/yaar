import { describe, it, expect } from 'bun:test';
import {
  parseYaarUri,
  parseBareWindowUri,
  isBareWindowsAuthority,
  resolveContentUri,
  expandBraceUri,
} from '../yaar-uri.js';

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

describe('parseYaarUri with config', () => {
  it('parses config URIs', () => {
    expect(parseYaarUri('yaar://config/settings')).toEqual({
      authority: 'config',
      path: 'settings',
    });
  });

  it('rejects the retired top-level browser authority', () => {
    // The `yaar://browser/*` verb namespace was removed; the real browser is now driven
    // through the `browser-user` app + POST /api/bridge, not a URI authority.
    expect(parseYaarUri('yaar://browser/0')).toBeNull();
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

  it('parses user URIs (user-facing namespace, open to all agents)', () => {
    expect(parseYaarUri('yaar://user/notifications')).toEqual({
      authority: 'user',
      path: 'notifications',
    });
    expect(parseYaarUri('yaar://user/prompts')).toEqual({
      authority: 'user',
      path: 'prompts',
    });
  });

  it('returns null for removed monitors authority', () => {
    expect(parseYaarUri('yaar://monitors/0/win-id')).toBeNull();
  });
});

describe('resolveContentUri', () => {
  it('resolves app-scoped storage to the shared storage route', () => {
    // The files live at storage/apps/{appId}/…, served by /api/storage — not by
    // /api/apps, which serves the app's own source/dist directory.
    expect(resolveContentUri('yaar://apps/anima/storage/generated/x.png')).toBe(
      '/api/storage/apps/anima/generated/x.png',
    );
    expect(resolveContentUri('yaar://apps/anima/storage')).toBe('/api/storage/apps/anima');
  });

  it('resolves an app root to its built entry point', () => {
    expect(resolveContentUri('yaar://apps/anima')).toBe('/api/apps/anima/dist/index.html');
  });

  it('resolves other app subpaths to the app static route', () => {
    expect(resolveContentUri('yaar://apps/anima/dist/index.html')).toBe(
      '/api/apps/anima/dist/index.html',
    );
  });

  it('resolves shared storage URIs unchanged', () => {
    expect(resolveContentUri('yaar://storage/notes/a.md')).toBe('/api/storage/notes/a.md');
  });
});

// ============ Brace expansion ============

describe('expandBraceUri', () => {
  it('expands a single brace group and trims whitespace', () => {
    expect(expandBraceUri('yaar://storage/{a.txt, b.txt}')).toEqual([
      'yaar://storage/a.txt',
      'yaar://storage/b.txt',
    ]);
  });

  it('returns URIs without braces unchanged', () => {
    expect(expandBraceUri('yaar://storage/file.txt')).toEqual(['yaar://storage/file.txt']);
  });

  it('does not treat single-item braces as expansion', () => {
    expect(expandBraceUri('yaar://storage/{file}.txt')).toEqual(['yaar://storage/{file}.txt']);
  });

  it('expands the first brace group when several are present', () => {
    expect(expandBraceUri('yaar://storage/{a,b}/{c,d}')).toEqual([
      'yaar://storage/a/{c,d}',
      'yaar://storage/b/{c,d}',
    ]);
  });

  it('skips a single-item group and expands the first expandable one', () => {
    expect(expandBraceUri('yaar://storage/{dir}/{a.txt,b.txt}')).toEqual([
      'yaar://storage/{dir}/a.txt',
      'yaar://storage/{dir}/b.txt',
    ]);
  });
});
