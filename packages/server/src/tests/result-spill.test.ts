/**
 * Oversized verb results spill into storage, and `chars` pages them back.
 *
 * Issue #105: a 158,721-char one-line transcript overflowed the CLI's result threshold, the
 * CLI persisted it under `~/.claude/…/tool-results/` where no YAAR principal can read, and
 * `lines`/`pattern` could only return that one line whole. The two halves are pinned
 * together because either alone leaves the agent stuck: a spill it cannot page is the same
 * dead end one level down.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { applyReadOptions, CHAR_PAGE_SIZE, hasLineFilter } from '../lib/read-options.js';
import { ok, okResource } from '../lib/verb-result.js';
import { SPILL_DIR, SPILL_THRESHOLD_CHARS, spillOversizedResult } from '../mcp/result-spill.js';
import { storageDelete, storageRead } from '../storage/storage-manager.js';

const ONE_LINE = 'abcdefghij'.repeat(15_000); // 150,000 chars, no newline

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const block = result.content[0];
  if (block?.type !== 'text' || block.text === undefined) throw new Error('no text block');
  return block.text;
}

afterAll(async () => {
  await storageDelete(SPILL_DIR);
});

describe('read chars', () => {
  it('slices a single huge line by offset, end exclusive', () => {
    const out = applyReadOptions(ONE_LINE, 'big.txt', { chars: '10-25' });
    expect(out).toBe(
      `── big.txt chars 10-25 of 150000 — next: chars "25-${25 + CHAR_PAGE_SIZE}" ──\n` +
        ONE_LINE.slice(10, 25),
    );
  });

  it('a bare offset reads one page, and an open range reads to the end', () => {
    expect(applyReadOptions(ONE_LINE, 'f', { chars: '0' }).split('\n')[1]).toHaveLength(
      CHAR_PAGE_SIZE,
    );
    const tail = applyReadOptions(ONE_LINE, 'f', { chars: '149990-' });
    expect(tail).toBe(`── f chars 149990-150000 of 150000 ──\n${ONE_LINE.slice(149990)}`);
  });

  it('refuses a bad range, an offset past the end, and mixing with lines/pattern', () => {
    expect(applyReadOptions('abc', 'f', { chars: 'x' })).toStartWith('Invalid char range');
    expect(applyReadOptions('abc', 'f', { chars: '5-9' })).toStartWith('Char offset 5');
    expect(applyReadOptions('abc', 'f', { chars: '2-1' })).toStartWith('Invalid char range');
    expect(applyReadOptions('abc', 'f', { chars: '0-1', lines: '1' })).toStartWith(
      'chars cannot be combined',
    );
  });

  it('counts as a filter, so handlers apply it instead of the registry noting it ignored', () => {
    expect(hasLineFilter({ chars: '0-10' })).toBe(true);
  });
});

describe('spillOversizedResult', () => {
  it('passes a result under the threshold through untouched', async () => {
    const small = ok('x'.repeat(1000));
    expect(await spillOversizedResult('invoke', ['yaar://http'], small)).toBe(small);
  });

  it('writes an oversized result to storage and points at it with a chars hint', async () => {
    const body = 'y'.repeat(SPILL_THRESHOLD_CHARS + 1);
    const result = await spillOversizedResult('invoke', ['yaar://http'], ok(body));

    const text = textOf(result);
    const uri = text.match(/saved in full at (yaar:\/\/storage\/\S+)/)?.[1];
    expect(uri).toStartWith(`yaar://storage/${SPILL_DIR}/`);
    expect(text).toContain(`{ chars: '0-${CHAR_PAGE_SIZE}' }`);
    expect(text.length).toBeLessThan(5_000);

    const stored = await storageRead(uri!.slice('yaar://storage/'.length));
    expect(stored.content).toBe(body);
  });

  it('spills structuredContent, which is what a model reads beside it', async () => {
    const data = { rows: Array.from({ length: 5_000 }, (_, i) => ({ i, v: 'z'.repeat(20) })) };
    const result = await spillOversizedResult('read', ['yaar://windows/w'], {
      content: [{ type: 'text', text: 'ignored by the model' }],
      structuredContent: data,
    });
    expect(result.structuredContent).toBeUndefined();
    const uri = textOf(result).match(/saved in full at (\S+)/)![1];
    expect(uri).toEndWith('.json');
    const stored = await storageRead(uri.slice('yaar://storage/'.length));
    expect(JSON.parse(stored.content!)).toEqual(data);
  });

  it('points a storage file read back at the file instead of copying it', async () => {
    const uri = 'yaar://storage/files/transcript.txt';
    const result = await spillOversizedResult(
      'read',
      [uri],
      okResource(uri, `1│${ONE_LINE}`, 'text/plain'),
    );
    expect(textOf(result)).toContain(`the full text is at ${uri}\n`);
    expect(textOf(result)).not.toContain('lines)');
  });

  it('keeps an image-bearing result as is — its size is not pageable text', async () => {
    const withImage = {
      content: [
        { type: 'text' as const, text: 'x'.repeat(SPILL_THRESHOLD_CHARS) },
        { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' },
      ],
    };
    expect(await spillOversizedResult('read', ['yaar://storage/a.png'], withImage)).toBe(withImage);
  });

  it('keeps isError on the pointer', async () => {
    const result = await spillOversizedResult('invoke', ['yaar://http'], {
      ...ok('e'.repeat(SPILL_THRESHOLD_CHARS + 1)),
      isError: true,
    });
    expect(result.isError).toBe(true);
  });
});
