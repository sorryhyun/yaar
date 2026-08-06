/**
 * The `/api/verb` envelope over VerbResults that carry `structuredContent`.
 *
 * `structuredContent` is the lossless, typed copy of a result for programmatic consumers;
 * `content` stays the model-facing channel. These assert the two shapes a caller sees —
 * and that the `{ items }` array wrapper (MCP forbids a bare-array structuredContent) is
 * never confused with an app that genuinely returns an object keyed `items`.
 */

import { describe, expect, test } from 'bun:test';
import { handleVerbRoutes, toEnvelope } from '../http/routes/verb.js';
import { formatBatchResults, okJson, okLinks } from '../handlers/utils.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import type { VerbResult } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

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

describe('brace expansion is MCP-only', () => {
  test('a brace URI is refused at the door, by name', async () => {
    const token = generateIframeToken('win-brace', 'sess-envelope' as SessionId, {
      appId: 'notes',
      permissions: ['yaar://storage/'],
    });
    const req = new Request('http://localhost:8000/api/verb', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iframe-token': token },
      body: JSON.stringify({ verb: 'read', uri: 'yaar://storage/{a.txt,b.txt}' }),
    });
    const res = await handleVerbRoutes(req, new URL(req.url));

    // It used to reach the registry as a literal URI and come back "No handler
    // registered for …", which points an app at the wrong problem entirely.
    expect(res?.status).toBe(400);
    const text = await res!.text();
    expect(text).toContain('Brace expansion is MCP-only');
    expect(text).not.toContain('No handler registered');
  });

  test('so the envelope has no batch shape to produce', () => {
    // `formatBatchResults` is what the MCP `exec` wrapper builds from an expansion.
    // Nothing hands one of these to `toEnvelope`, and it no longer sniffs for the
    // `--- uri ---` headers — the two are coupled by nothing but that string format.
    const batch = formatBatchResults(
      ['yaar://storage/a.txt', 'yaar://storage/b.txt'],
      [
        { status: 'fulfilled', value: { content: [{ type: 'text', text: 'A' }] } },
        { status: 'fulfilled', value: { content: [{ type: 'text', text: 'B' }] } },
      ],
    );
    const envelope = toEnvelope(batch);
    // No `{ [uri]: parsed }` map any more — the door reads the first text block like
    // any other single result. Should expansion ever reach this door, it must be
    // handled deliberately rather than by re-parsing a display string.
    expect(envelope.data).not.toHaveProperty('yaar://storage/a.txt');
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
