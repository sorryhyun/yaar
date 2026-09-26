/**
 * Shared MCP tool-result formatting (`providers/mcp-content.ts`).
 *
 * This used to be written twice, once per provider mapper, and the copies had
 * drifted — no separator between joined blocks on Claude's side, no `isError`
 * prefix there either, an unrecognized block type silently dropped instead of
 * surfaced. These tests pin the unified behaviour both `claude/message-mapper.ts`
 * and `codex/message-mapper.ts` now depend on.
 */
import { describe, it, expect } from 'bun:test';
import { formatMcpContentBlock, formatMcpResult } from '../providers/mcp-content.js';

describe('formatMcpContentBlock', () => {
  it('passes a bare string through', () => {
    expect(formatMcpContentBlock('hello')).toBe('hello');
  });

  it('reads an explicit text block, and a bare { text } shape', () => {
    expect(formatMcpContentBlock({ type: 'text', text: 'hi' })).toBe('hi');
    expect(formatMcpContentBlock({ text: 'hi' })).toBe('hi');
  });

  it('does not dump base64 for image or audio blocks', () => {
    expect(formatMcpContentBlock({ type: 'image', data: 'AAAA==', mimeType: 'image/png' })).toBe(
      '[image omitted]',
    );
    expect(formatMcpContentBlock({ type: 'audio', data: 'ZZZZ==', mimeType: 'audio/wav' })).toBe(
      '[audio omitted]',
    );
  });

  it('surfaces embedded resource text, and a URI marker for a blob resource', () => {
    expect(
      formatMcpContentBlock({ type: 'resource', resource: { uri: 'file://a.txt', text: 'body' } }),
    ).toBe('body');
    const blob = formatMcpContentBlock({
      type: 'resource',
      resource: { uri: 'file://a.bin', blob: 'RAWBYTES==' },
    });
    expect(blob).toBe('[resource: file://a.bin]');
    expect(blob).not.toContain('RAWBYTES');
  });

  it('falls back to a marker when a resource has neither text nor uri', () => {
    expect(formatMcpContentBlock({ type: 'resource', resource: {} })).toBe('[resource omitted]');
  });

  it('renders resource_link as a markdown link', () => {
    expect(
      formatMcpContentBlock({ type: 'resource_link', name: 'Report', uri: 'https://x/r' }),
    ).toBe('[Report](https://x/r)');
    // Missing name/uri still produce something rather than throwing.
    expect(formatMcpContentBlock({ type: 'resource_link' })).toBe('[link]()');
  });

  it('stringifies genuinely-unknown block shapes, and non-object blocks', () => {
    expect(formatMcpContentBlock({ type: 'mystery', foo: 1 })).toBe('{"type":"mystery","foo":1}');
    expect(formatMcpContentBlock(42)).toBe('42');
    expect(formatMcpContentBlock(null)).toBe('null');
  });
});

describe('formatMcpResult', () => {
  it('returns a plain string content as-is, even when empty', () => {
    expect(formatMcpResult({ content: 'plain text' })).toBe('plain text');
    expect(formatMcpResult({ content: '' })).toBe('');
  });

  it('joins content blocks with a newline', () => {
    expect(
      formatMcpResult({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toBe('hello\nworld');
  });

  it('drops blocks that contribute nothing before joining', () => {
    expect(
      formatMcpResult({
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'kept' },
        ],
      }),
    ).toBe('kept');
  });

  it('prefixes a string result with Error: when isError is set', () => {
    expect(formatMcpResult({ content: 'boom', isError: true })).toBe('Error: boom');
  });

  it('prefixes a joined block result with Error: when isError is set', () => {
    expect(formatMcpResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBe(
      'Error: boom',
    );
    expect(formatMcpResult({ content: [{ type: 'text', text: 'ok' }], isError: false })).toBe('ok');
  });

  it('falls back to structuredContent, pretty-printed, when content yields nothing', () => {
    expect(formatMcpResult({ content: [], structuredContent: { count: 2 } })).toBe(
      JSON.stringify({ count: 2 }, null, 2),
    );
  });

  it('falls back to a default when there is nothing at all', () => {
    expect(formatMcpResult({ content: [] })).toBe('Tool completed');
    expect(formatMcpResult(undefined)).toBe('Tool completed');
    expect(formatMcpResult(null)).toBe('Tool completed');
    expect(formatMcpResult({})).toBe('Tool completed');
  });

  it('does not prefix Error: onto the structuredContent/default fallback', () => {
    // isError is only meaningful for the tool's own words (content); a fallback
    // is this formatter's text, not the tool's, so it is never wrapped.
    expect(formatMcpResult({ content: [], structuredContent: { ok: false }, isError: true })).toBe(
      JSON.stringify({ ok: false }, null, 2),
    );
    expect(formatMcpResult({ content: [], isError: true })).toBe('Tool completed');
  });
});
