/**
 * Provider parity for incremental response text.
 *
 * The agent stream begins at `StreamMessage`, so everything downstream — the
 * coalescer, the turn boundaries, Process Explorer — is provider-neutral *only
 * if* both mappers normalize incremental output the same way. Two properties
 * carry that, and both are easy to break by accident:
 *
 *   1. **Deltas arrive incrementally**, one `{ type: 'text', content }` per
 *      provider chunk, in order. A mapper that waited for the completed message
 *      would still render correctly and still look "streaming" in the CLI panel,
 *      while giving observers one block at the end.
 *   2. **The completed snapshot does not repeat the deltas.** Both providers
 *      send the assembled assistant message *after* streaming it; emitting its
 *      content again doubles every response for anyone accumulating deltas
 *      (`state.responseText`, and any app folding `text` frames).
 *
 * These are unit tests over the two mapper functions — no SDK, no app-server —
 * because the property under test is the normalization, not the transport.
 */
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapClaudeMessage } from '../providers/claude/message-mapper.js';
import { mapNotification } from '../providers/codex/message-mapper.js';
import type { StreamMessage } from '../providers/types.js';

/** Keep only the messages a text observer would see, dropping session-tracking pings. */
function textContent(messages: (StreamMessage | null)[]): string[] {
  return messages
    .filter((m): m is StreamMessage => m?.type === 'text' && typeof m.content === 'string')
    .map((m) => m.content!);
}

describe('provider delta parity — Claude', () => {
  /** A `stream_event` carrying one `text_delta`, as the SDK spells it. */
  const textDelta = (text: string) =>
    ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }) as unknown as SDKMessage;

  it('normalizes text_delta events into ordered incremental text messages', () => {
    const mapped = ['Hel', 'lo ', 'world'].map(textDelta).map(mapClaudeMessage);
    expect(textContent(mapped)).toEqual(['Hel', 'lo ', 'world']);
  });

  it('does not repeat streamed text when the assistant snapshot arrives', () => {
    // The SDK sends the assembled `assistant` message after the deltas. It must
    // map to a session-tracking ping with no content, or the turn doubles.
    const snapshot = mapClaudeMessage({
      type: 'assistant',
      session_id: 'ses-1',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    } as unknown as SDKMessage);

    expect(snapshot).toEqual({ type: 'text', sessionId: 'ses-1' });
    expect(textContent([snapshot])).toEqual([]);
  });

  it('maps thinking_delta to thinking and result to a terminal complete', () => {
    const thinking = mapClaudeMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      },
    } as unknown as SDKMessage);
    expect(thinking).toEqual({ type: 'thinking', content: 'hmm' });

    const done = mapClaudeMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'ses-1',
    } as unknown as SDKMessage);
    expect(done).toEqual({ type: 'complete', sessionId: 'ses-1' });
  });
});

describe('provider delta parity — Codex', () => {
  it('normalizes agentMessage deltas into ordered incremental text messages', () => {
    const mapped = ['Hel', 'lo ', 'world'].map((delta) =>
      mapNotification('item/agentMessage/delta', { delta }),
    );
    expect(textContent(mapped)).toEqual(['Hel', 'lo ', 'world']);
  });

  it('does not repeat streamed text when the completed item arrives', () => {
    const completed = mapNotification('item/agentMessage/completed', {
      item: { type: 'agentMessage', text: 'Hello world' },
    });
    expect(completed).toBeNull();
  });

  it('maps reasoning textDelta to thinking and turn/completed to a terminal complete', () => {
    expect(mapNotification('item/reasoning/textDelta', { delta: 'hmm' })).toEqual({
      type: 'thinking',
      content: 'hmm',
    });
    expect(mapNotification('turn/completed', { turn: { status: 'completed' } })).toEqual({
      type: 'complete',
    });
  });

  it('reports an interrupted or failed turn as an error, not a clean complete', () => {
    expect(mapNotification('turn/completed', { turn: { status: 'interrupted' } })).toMatchObject({
      type: 'error',
    });
    expect(
      mapNotification('turn/completed', {
        turn: { status: 'failed', error: { message: 'boom' } },
      }),
    ).toEqual({ type: 'error', error: 'boom' });
  });
});

describe('tool parameter streaming — Claude', () => {
  /**
   * The gap this closes: a tool call used to be invisible until its arguments
   * were complete, because `content_block_start` and every `input_json_delta`
   * returned null. For a large input that is seconds to tens of seconds of dead
   * air. The name is known at `content_block_start` and the arguments arrive as
   * deltas, so both are now forwarded — while still being buffered, because
   * `tool_use` remains the authoritative message.
   */
  const start = (name: string, id: string) =>
    ({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name, id },
      },
    }) as unknown as SDKMessage;
  const inputDelta = (partial_json: string) =>
    ({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json },
      },
    }) as unknown as SDKMessage;
  const stop = () =>
    ({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }) as unknown as SDKMessage;

  it('announces the tool name before any argument has arrived', () => {
    expect(mapClaudeMessage(start('Write', 'tu_1'))).toEqual({
      type: 'tool_use_start',
      toolName: 'Write',
      toolUseId: 'tu_1',
    });
  });

  it('forwards argument fragments as display-only deltas, in order', () => {
    mapClaudeMessage(start('Write', 'tu_2'));
    const fragments = ['{"path":', '"/tmp/a.txt",', '"body":"hello"}'];
    const mapped = fragments.map((f) => mapClaudeMessage(inputDelta(f)));

    expect(mapped.map((m) => m?.type)).toEqual(Array(3).fill('tool_input_delta'));
    expect(mapped.map((m) => m?.content)).toEqual(fragments);
    // The name rides along so a consumer can label the feed without tracking ids.
    expect(mapped[0]?.toolName).toBe('Write');
  });

  it('still emits the authoritative tool_use with fully parsed input at block stop', () => {
    mapClaudeMessage(start('Write', 'tu_3'));
    for (const f of ['{"path":', '"/tmp/a.txt"}']) mapClaudeMessage(inputDelta(f));

    // The deltas were forwarded *and* buffered — streaming them must not consume
    // them, or the real call would arrive with no arguments.
    expect(mapClaudeMessage(stop())).toEqual({
      type: 'tool_use',
      toolName: 'Write',
      toolUseId: 'tu_3',
      toolInput: { path: '/tmp/a.txt' },
    });
  });

  it('records escape spellings from the raw JSON before parse erases them', () => {
    mapClaudeMessage(start('mcp__verbs__invoke', 'tu_esc1'));
    // Escape split across fragments on purpose — chunks are joined before scanning.
    for (const f of ['{"message":"\\uc5', '48\\ub155"}']) mapClaudeMessage(inputDelta(f));

    expect(mapClaudeMessage(stop())).toEqual({
      type: 'tool_use',
      toolName: 'mcp__verbs__invoke',
      toolUseId: 'tu_esc1',
      toolInput: { message: '안녕' },
      toolInputEscapes: { unicodeEscapes: 2, literalBackslashU: 0 },
    });
  });

  it('omits toolInputEscapes when the model wrote literal characters', () => {
    mapClaudeMessage(start('mcp__verbs__invoke', 'tu_esc2'));
    mapClaudeMessage(inputDelta('{"message":"안녕"}'));

    const result = mapClaudeMessage(stop());
    expect(result?.toolInput).toEqual({ message: '안녕' });
    expect(result && 'toolInputEscapes' in result).toBe(false);
  });

  it('counts double-escaped sequences as literalBackslashU — the corrupting form', () => {
    mapClaudeMessage(start('mcp__verbs__invoke', 'tu_esc3'));
    // Raw JSON `\\uc548` parses to the literal text `안` in the value.
    mapClaudeMessage(inputDelta('{"message":"\\\\uc548"}'));

    expect(mapClaudeMessage(stop())).toMatchObject({
      toolInput: { message: '\\uc548' },
      toolInputEscapes: { unicodeEscapes: 0, literalBackslashU: 1 },
    });
  });

  it('does not count mandatory control-character escapes as a spelling choice', () => {
    mapClaudeMessage(start('mcp__verbs__invoke', 'tu_esc4'));
    //   has no literal spelling in JSON — the escape is required, not chosen.
    mapClaudeMessage(inputDelta('{"message":"a\\u0000b"}'));

    const result = mapClaudeMessage(stop());
    expect(result && 'toolInputEscapes' in result).toBe(false);
  });

  it('survives malformed argument JSON without losing the call', () => {
    mapClaudeMessage(start('Write', 'tu_4'));
    mapClaudeMessage(inputDelta('{"path": "unterminated'));
    // A truncated argument stream still yields the call, just without input —
    // the streamed fragments are display-only precisely because of this case.
    expect(mapClaudeMessage(stop())).toMatchObject({
      type: 'tool_use',
      toolName: 'Write',
      toolInput: undefined,
    });
  });
});

describe('provider delta parity — the shared contract', () => {
  /**
   * The point of the two suites above, asserted directly: feed each provider its
   * own spelling of the same turn and the normalized text is identical. This is
   * what lets Phase 2.1 reason about one stream contract instead of two.
   */
  it('produces the same normalized text for the same turn on both providers', () => {
    const chunks = ['The ', 'answer ', 'is 42.'];

    const claude = textContent(
      chunks.map((text) =>
        mapClaudeMessage({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        } as unknown as SDKMessage),
      ),
    );
    const codex = textContent(
      chunks.map((delta) => mapNotification('item/agentMessage/delta', { delta })),
    );

    expect(claude).toEqual(chunks);
    expect(codex).toEqual(claude);
  });
});
