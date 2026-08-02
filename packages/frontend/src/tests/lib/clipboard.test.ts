/**
 * The two decisions in the clipboard leg that are pure, and that both matter for the same
 * reason: whatever they produce is read by a model, which will act on it.
 *
 * `classifyClipboardError` — the platform gives a denied permission and an unfocused tab
 * the *same* `NotAllowedError`, and the fixes are nothing alike ("grant clipboard access
 * in site settings" vs "click the desktop"). The distinction exists only in the message
 * string, so it is made here, once, where the exception still exists.
 *
 * `truncateClipboardText` — clipboard text is trimmed in the browser, before it crosses
 * the socket. A naive `slice` cuts surrogate pairs in half, and a lone surrogate survives
 * JSON to arrive as U+FFFD: a truncation silently becomes a corruption, at exactly the
 * boundary a reader looks at first.
 */
import { describe, it, expect } from 'bun:test';
import { classifyClipboardError, truncateClipboardText } from '@/lib/clipboard';

function domError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('classifyClipboardError', () => {
  it('reads Chrome’s unfocused-document rejection as focus, not permission', () => {
    // Chrome's actual wording, and it arrives as NotAllowedError — the same name a real
    // denial uses. Reported as "denied", an agent sends the user to site settings to grant
    // a permission they had already granted.
    const result = classifyClipboardError(domError('NotAllowedError', 'Document is not focused.'));

    expect(result.reason).toBe('not-focused');
  });

  it('reads a genuine NotAllowedError as denied', () => {
    const result = classifyClipboardError(domError('NotAllowedError', 'Read permission denied.'));

    expect(result.reason).toBe('denied');
  });

  it('falls back to denied rather than not-focused for an unrecognized refusal', () => {
    // Of the two, "denied" points at something the user can actually go and change. A
    // wrong "not focused" sends them to click a desktop that was focused all along.
    const result = classifyClipboardError(domError('NotAllowedError', 'blocked by policy'));

    expect(result.reason).toBe('denied');
  });

  it('names an empty clipboard rather than a failure', () => {
    expect(classifyClipboardError(domError('NotFoundError', 'No data')).reason).toBe('empty');
  });

  it('carries the original message through for anything it does not recognize', () => {
    const result = classifyClipboardError(domError('TypeError', 'something odd'));

    expect(result.reason).toBe('failed');
    expect(result.error).toBe('something odd');
  });

  it('survives a non-Error rejection', () => {
    expect(classifyClipboardError('nope').reason).toBe('failed');
  });
});

describe('truncateClipboardText', () => {
  it('leaves text under the ceiling untouched and unmarked', () => {
    const result = truncateClipboardText('hello', 100);

    expect(result).toEqual({ text: 'hello' });
    // No `truncated`, no `totalChars` — a reader must be able to tell "all of it" from
    // "the start of it" without comparing lengths itself.
    expect(result.truncated).toBeUndefined();
  });

  it('reports the true length, not the trimmed one', () => {
    const result = truncateClipboardText('x'.repeat(500), 10);

    expect(result.text).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // Without this, "truncated" cannot tell 10 missing characters from 490.
    expect(result.totalChars).toBe(500);
  });

  it('never cuts a surrogate pair in half', () => {
    // '😀' is two UTF-16 code units (0xD83D, 0xDE00), so 'a😀bcdef' is 8 units long and a
    // ceiling of 2 lands between them — the one offset that can break the string.
    const result = truncateClipboardText('a😀bcdef', 2);

    expect(result.text).toBe('a');
    // The failure this guards against is `'a\ud83d'` — valid-looking, two code units long,
    // and rendered as a replacement character everywhere downstream.
    expect(result.text.charCodeAt(result.text.length - 1)).toBeLessThan(0xd800);
    expect(result.totalChars).toBe(8);
  });

  it('keeps a pair that ends exactly on the boundary', () => {
    // Cutting at 3 takes both halves. Backing off here would drop a character for nothing.
    const result = truncateClipboardText('a😀bcdef', 3);

    expect(result.text).toBe('a😀');
    expect(result.truncated).toBe(true);
  });

  it('treats a zero ceiling as no ceiling rather than as an empty read', () => {
    // `save` passes ceilings meant for a disk; a 0 there must not silently return nothing.
    expect(truncateClipboardText('hello', 0)).toEqual({ text: 'hello' });
  });
});
