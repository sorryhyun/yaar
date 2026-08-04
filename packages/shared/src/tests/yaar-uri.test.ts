import { describe, it, expect } from 'bun:test';
import {
  parseYaarUri,
  parseBareWindowUri,
  resolveContentUri,
  expandBraceUri,
  extractAppId,
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

  it('treats a trailing slash after the windowId as an empty (absent) subPath', () => {
    // splitFirst('my-win/') → ['my-win', ''] — the '' tail is normalized to undefined here,
    // same as the no-slash case, unlike resolveContentUri's `rest` which keeps '' as-is.
    expect(parseBareWindowUri('yaar://windows/my-win/')).toEqual({
      windowId: 'my-win',
      subPath: undefined,
    });
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

  it('keeps the trailing slash for a bare app id with a trailing slash', () => {
    // splitFirst('anima/') → ['anima', ''] — an empty (not undefined) rest, so this does NOT
    // take the no-slash `/dist/index.html` branch; it falls through to the generic app route.
    expect(resolveContentUri('yaar://apps/anima/')).toBe('/api/apps/anima/');
  });
});

describe('extractAppId', () => {
  it('extracts the app id when the URI has no further subpath', () => {
    expect(extractAppId('yaar://apps/anima')).toBe('anima');
  });

  it('extracts just the app id when a subpath follows', () => {
    expect(extractAppId('yaar://apps/anima/dist/index.html')).toBe('anima');
  });

  it('extracts the app id even with a trailing slash', () => {
    expect(extractAppId('yaar://apps/anima/')).toBe('anima');
  });

  it('returns null for a non-apps authority', () => {
    expect(extractAppId('yaar://storage/anima')).toBeNull();
  });

  it('strips a launch parameter — the app id is the app, not the query', () => {
    // resolveContentUri carries the query through to the iframe on purpose; the id in
    // it is still `anima`. Left on, this returned `anima?file=yaar:` and every
    // parameterized launch resolved to no app at all.
    expect(extractAppId('yaar://apps/anima?file=yaar://storage/files/x.md')).toBe('anima');
    expect(extractAppId('yaar://apps/anima#top')).toBe('anima');
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
