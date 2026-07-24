/**
 * The `/api/verb` envelope over VerbResults that carry `structuredContent`.
 *
 * `structuredContent` is the lossless, typed copy of a result for programmatic consumers;
 * `content` stays the model-facing channel. These assert the two shapes a caller sees —
 * and that the `{ items }` array wrapper (MCP forbids a bare-array structuredContent) is
 * never confused with an app that genuinely returns an object keyed `items`.
 */

import { describe, expect, test } from 'bun:test';
import { toEnvelope } from '../http/routes/verb.js';
import { okJson, okLinks } from '../handlers/utils.js';
import type { VerbResult } from '../handlers/uri-registry.js';

describe('okLinks', () => {
  test('carries the links as structuredContent.items and as resource_link blocks', () => {
    const result = okLinks([
      { uri: 'yaar://storage/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { uri: 'yaar://storage/sub', name: 'sub', description: 'directory' },
    ]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: 'resource_link', uri: 'yaar://storage/a.txt' });
    expect(result.structuredContent?.items).toEqual(result.content);
  });

  test('envelope hands apps a flat array of links', () => {
    const envelope = toEnvelope(
      okLinks([{ uri: 'yaar://storage/a.txt', name: 'a.txt', mimeType: 'text/plain' }]),
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual([
      { uri: 'yaar://storage/a.txt', name: 'a.txt', mimeType: 'text/plain' },
    ]);
  });

  test('an empty listing is an empty array, not the "(empty)" placeholder', () => {
    expect(toEnvelope(okLinks([]))).toEqual({ ok: true, data: [] });
  });
});

describe('okJson', () => {
  test('an object is mirrored losslessly into structuredContent', () => {
    const data = { count: 2, unit: 'fahrenheit' };
    const result = okJson(data);

    expect(result.structuredContent).toEqual(data);
    expect(toEnvelope(result)).toEqual({ ok: true, data });
  });

  test('an array stays text-only (structuredContent is object-only per MCP)', () => {
    const result = okJson([1, 2, 3]);

    expect(result.structuredContent).toBeUndefined();
    expect(toEnvelope(result)).toEqual({ ok: true, data: [1, 2, 3] });
  });
});

describe('the { items } wrapper', () => {
  test('an app object keyed "items" is not mistaken for an empty listing', () => {
    // What wrapAppValue produces for an app command returning `{ items: [] }`:
    // a serialized text block plus the object itself. It must survive intact.
    const appResult: VerbResult = {
      content: [{ type: 'text', text: JSON.stringify({ items: [] }, null, 2) }],
      structuredContent: { items: [] },
    };

    expect(toEnvelope(appResult)).toEqual({ ok: true, data: { items: [] } });
  });
});

describe('errors', () => {
  test('an error result reports the text blocks regardless of structuredContent', () => {
    const result: VerbResult = {
      content: [{ type: 'text', text: 'nope' }],
      structuredContent: { detail: 'nope' },
      isError: true,
    };

    expect(toEnvelope(result)).toEqual({ ok: false, error: 'nope' });
  });
});
