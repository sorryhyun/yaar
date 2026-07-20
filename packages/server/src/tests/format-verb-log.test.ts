import { describe, expect, it } from 'bun:test';
import { compactVerbPayload, shouldLogVerb } from '../lib/format-verb-log.js';

describe('shouldLogVerb', () => {
  it('skips the proxied-fetch data plane', () => {
    expect(shouldLogVerb('yaar://http')).toBe(false);
    expect(shouldLogVerb('yaar://http/anything')).toBe(false);
  });

  it('keeps desktop-level verbs', () => {
    expect(shouldLogVerb('yaar://storage/notes.md')).toBe(true);
    expect(shouldLogVerb('yaar://windows/win-1')).toBe(true);
    // A URI that merely starts with the same letters is not the http door.
    expect(shouldLogVerb('yaar://https-config')).toBe(true);
  });

  it('skips the devtools console poll', () => {
    expect(
      shouldLogVerb('yaar://windows/devtools-preview-1', {
        action: 'app_query',
        stateKey: '__console',
      }),
    ).toBe(false);
  });

  it('keeps other app_query state reads', () => {
    const uri = 'yaar://windows/devtools-preview-1';
    expect(shouldLogVerb(uri, { action: 'app_query', stateKey: 'selection' })).toBe(true);
    // Only the query verb is a poll — a command named `__console` is a real action.
    expect(shouldLogVerb(uri, { action: 'app_command', command: '__console' })).toBe(true);
    expect(shouldLogVerb(uri)).toBe(true);
  });
});

describe('compactVerbPayload', () => {
  it('drops headers and truncates long strings', () => {
    const out = compactVerbPayload({
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 …', Referer: 'https://m.dcinside.com/' },
      content: 'x'.repeat(500),
    });
    expect(out).toBeDefined();
    expect(out).not.toHaveProperty('headers');
    expect(out!.method).toBe('GET');
    expect(out!.content as string).toContain('(500 chars)');
    expect((out!.content as string).length).toBeLessThan(160);
  });

  it('collapses nesting and arrays', () => {
    const out = compactVerbPayload({
      items: [1, 2, 3, 4, 5],
      deep: { level1: { level2: { level3: 'hidden' } } },
    });
    expect(out!.items).toEqual([1, 2, 3]);
    expect((out!.deep as Record<string, unknown>).level1).toBe('{…}');
  });

  it('returns undefined for empty or non-object payloads', () => {
    expect(compactVerbPayload(undefined)).toBeUndefined();
    expect(compactVerbPayload({})).toBeUndefined();
    expect(compactVerbPayload('string')).toBeUndefined();
  });
});
