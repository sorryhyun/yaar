/**
 * What a *model* receives from a verb tool, as opposed to what `/api/verb` receives.
 *
 * `content` is the model's channel and `structuredContent` is the app's. A client that
 * sees both is entitled to prefer the structured copy — MCP pairs it with an `outputSchema`
 * and the verbs declare none — and Claude Code does exactly that, keeping only the non-text
 * blocks and replacing the rest with a compact `JSON.stringify`. That deleted the layout
 * context, the read↔list fallback notes, and `wrapAppValue`'s truncation on the way past.
 *
 * So the MCP boundary (`forModel`) strips it, and these assert the two halves stay apart:
 * nothing the model is meant to read may travel only in `structuredContent`, and
 * `toEnvelope` must still get the typed copy through the direct-`execute` path it uses.
 */

import { describe, expect, test } from 'bun:test';
import { forModel } from '../handlers/index.js';
import { okJson, okLinks, prependNote, EMPTY_LIST_TEXT } from '../handlers/utils.js';
import { toEnvelope } from '../http/routes/verb.js';

describe('forModel', () => {
  test('drops structuredContent so the text block is what the model reads', () => {
    const result = forModel(okJson({ windowId: 'memo', renderConfirmed: true }));

    expect('structuredContent' in result).toBe(false);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ windowId: 'memo', renderConfirmed: true }, null, 2) },
    ]);
  });

  test('keeps every appended text block — the layout context lives in one', () => {
    const withLayout = {
      ...okJson({ ok: true }),
      content: [
        ...okJson({ ok: true }).content,
        { type: 'text' as const, text: '[layout] viewport: 1920×1080' },
      ],
    };

    const content = forModel(withLayout).content;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: 'text', text: '[layout] viewport: 1920×1080' });
  });

  test('keeps a prepended note ahead of the payload', () => {
    const content = forModel(prependNote(okJson({ files: [] }), 'This is a folder')).content;

    expect(content[0]).toEqual({ type: 'text', text: '(This is a folder)' });
    expect(content).toHaveLength(2);
  });

  test('a listing keeps its resource_link blocks and stops duplicating them as JSON', () => {
    const result = forModel(okLinks([{ uri: 'yaar://storage/a.txt', name: 'a.txt' }]));

    expect('structuredContent' in result).toBe(false);
    expect(result.content).toEqual([
      { type: 'resource_link', uri: 'yaar://storage/a.txt', name: 'a.txt' },
    ]);
  });

  test('an empty listing keeps the "(empty)" sentinel rather than {"items":[]}', () => {
    expect(forModel(okLinks([])).content).toEqual([{ type: 'text', text: EMPTY_LIST_TEXT }]);
  });

  test('passes a text-only result through untouched', () => {
    const result = { content: [{ type: 'text' as const, text: 'nope' }], isError: true };
    expect(forModel(result)).toBe(result);
  });

  test('preserves isError', () => {
    expect(forModel({ ...okJson({ reason: 'no' }), isError: true }).isError).toBe(true);
  });
});

describe('the app channel is unaffected', () => {
  test('toEnvelope still reads structuredContent — /api/verb never goes through forModel', () => {
    // routes/verb.ts calls registry.execute() directly; only the MCP tool wrapper strips.
    expect(toEnvelope(okJson({ scene: { nodes: 3 } }))).toEqual({
      ok: true,
      data: { scene: { nodes: 3 } },
    });
  });
});
