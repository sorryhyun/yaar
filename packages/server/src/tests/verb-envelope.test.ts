/**
 * The `/api/verb` envelope over VerbResults, with and without `structuredContent`.
 *
 * `structuredContent` is the lossless, typed copy of a result for programmatic consumers —
 * and, when present, what both model clients read instead of the text blocks. These assert
 * the shapes a caller sees, that a listing carries no such copy (it would reach a Claude
 * model twice and hide every note), and that an app object keyed `items` is never confused
 * with an empty listing.
 */

import { describe, expect, test } from 'bun:test';
import { handleVerbRoutes, toEnvelope } from '../http/routes/verb.js';
import { foldNotes, formatBatchResults, okJson, okLinks, prependNote } from '../handlers/utils.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import type { VerbResult } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

describe('okLinks', () => {
  test('carries the links as resource_link blocks only, with no structuredContent', () => {
    const result = okLinks([
      { uri: 'yaar://storage/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { uri: 'yaar://storage/sub', name: 'sub', description: 'directory' },
    ]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: 'resource_link', uri: 'yaar://storage/a.txt' });
    // With a `structuredContent` beside them, the Claude CLI delivers the list twice and
    // both clients drop the text blocks — so a prepended note would never be read.
    expect(result.structuredContent).toBeUndefined();
  });

  test('a prepended note stays in the content a model reads, ahead of the links', () => {
    const result = prependNote(okLinks([{ uri: 'yaar://storage/a.txt', name: 'a.txt' }]), 'hi');

    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: '(hi)' });
    expect(toEnvelope(result)).toEqual({
      ok: true,
      data: [{ uri: 'yaar://storage/a.txt', name: 'a.txt' }],
    });
  });

  test('an empty listing with a note is still an empty array', () => {
    expect(toEnvelope(prependNote(okLinks([]), 'hi'))).toEqual({ ok: true, data: [] });
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

  // An object's text reaches only the log; an array's is what the model reads, because
  // nothing stands in for it. So only the object earns the gutter, and only while small.
  test('a small object is indented, a large one compact, and an array compact at any size', () => {
    const small = { a: 1 };
    const large = { blob: 'x'.repeat(10_000) };
    const text = (data: object) => (okJson(data).content[0] as { text: string }).text;

    expect(text(small)).toBe(JSON.stringify(small, null, 2));
    expect(text(large)).toBe(JSON.stringify(large));
    expect(text([{ a: 1 }])).toBe('[{"a":1}]');
  });
});

describe('notes beside structuredContent', () => {
  // Both model clients read `structuredContent` in place of text blocks, so a note on an
  // object result has to travel inside it — but only at the MCP boundary, not to apps.
  test('prependNote records the note but leaves the app-facing data alone', () => {
    const result = prependNote(okJson({ windowId: 'w1' }), 'opened for you');

    expect(result.content[0]).toEqual({ type: 'text', text: '(opened for you)' });
    expect(result.notes).toEqual(['opened for you']);
    expect(toEnvelope(result)).toEqual({ ok: true, data: { windowId: 'w1' } });
  });

  test('foldNotes carries the notes into the object, first, newest first', () => {
    const folded = foldNotes(
      prependNote(prependNote(okJson({ windowId: 'w1' }), 'older'), 'newer'),
    );

    expect(folded.notes).toBeUndefined();
    expect(folded.structuredContent).toEqual({ _notes: ['newer', 'older'], windowId: 'w1' });
    expect(Object.keys(folded.structuredContent!)[0]).toBe('_notes');
  });

  test('a result without structuredContent records nothing to fold', () => {
    const result = prependNote(okLinks([{ uri: 'yaar://storage/a.txt', name: 'a.txt' }]), 'hi');

    expect(result.notes).toBeUndefined();
    expect(foldNotes(result)).toEqual(result);
  });
});

describe('empty-listing detection', () => {
  test('an app returning the "(empty)" string is not mistaken for an empty listing', () => {
    expect(toEnvelope({ content: [{ type: 'text', text: '(empty)' }] })).toEqual({
      ok: true,
      data: '(empty)',
    });
  });

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
