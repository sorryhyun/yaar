/**
 * Codex MCP tool-result formatting — the read side of structured tool responses.
 *
 * `StreamMessage.content` is a string, so non-text MCP content blocks must degrade.
 * These tests pin that the degradation is deliberate: binary-carrying blocks
 * (image / audio / blob resource) become short markers rather than a raw base64
 * dump, resource/resource_link surface their text or URI, unknown shapes still
 * stringify, and an MCP-level `isError` flag is honored even though codex's typed
 * result doesn't expose it. Driven through the public `mapNotification` entry.
 */
import { describe, it, expect } from 'bun:test';
import { mapNotification } from '../providers/codex/message-mapper.js';

/** Build an `item/mcpToolCall/completed` result and return its mapped content string. */
function mapResult(result: unknown): string {
  const msg = mapNotification('item/mcpToolCall/completed', {
    type: 'mcpToolCall',
    server: 'srv',
    tool: 'thing',
    result,
  });
  expect(msg?.type).toBe('tool_result');
  return (msg as { content: string }).content;
}

describe('codex formatMcpResult', () => {
  it('joins text blocks', () => {
    expect(
      mapResult({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toBe('hello\nworld');
  });

  it('does not dump base64 for image or audio blocks', () => {
    const out = mapResult({
      content: [
        { type: 'text', text: 'here:' },
        { type: 'image', data: 'AAAABBBBCCCC==', mimeType: 'image/png' },
        { type: 'audio', data: 'ZZZZYYYY==', mimeType: 'audio/wav' },
      ],
    });
    expect(out).toBe('here:\n[image omitted]\n[audio omitted]');
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('ZZZZ');
  });

  it('surfaces embedded resource text, and URI for blob resources', () => {
    expect(
      mapResult({
        content: [{ type: 'resource', resource: { uri: 'file://a.txt', text: 'body' } }],
      }),
    ).toBe('body');
    const blob = mapResult({
      content: [{ type: 'resource', resource: { uri: 'file://a.bin', blob: 'RAWBYTES==' } }],
    });
    expect(blob).toBe('[resource: file://a.bin]');
    expect(blob).not.toContain('RAWBYTES');
  });

  it('renders resource_link as a markdown link', () => {
    expect(
      mapResult({ content: [{ type: 'resource_link', name: 'Report', uri: 'https://x/r' }] }),
    ).toBe('[Report](https://x/r)');
  });

  it('stringifies genuinely-unknown block shapes', () => {
    expect(mapResult({ content: [{ type: 'mystery', foo: 1 }] })).toBe(
      '{"type":"mystery","foo":1}',
    );
  });

  it('honors an MCP-level isError flag', () => {
    expect(mapResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBe(
      'Error: boom',
    );
    expect(mapResult({ content: [{ type: 'text', text: 'ok' }], isError: false })).toBe('ok');
  });

  it('falls back to structured content, then a default', () => {
    expect(mapResult({ content: [], structuredContent: { count: 2 } })).toBe(
      JSON.stringify({ count: 2 }, null, 2),
    );
    expect(mapResult({ content: [] })).toBe('Tool completed');
  });
});
