import { describe, it, expect } from 'vitest';
import {
  parseWindowUri,
  buildWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
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
