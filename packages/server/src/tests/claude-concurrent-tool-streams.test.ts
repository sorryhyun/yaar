/**
 * Two agents streaming tool calls at once must not share a tool-call buffer.
 *
 * Content-block indices restart at 0 in every assistant message, so when the
 * buffer lived at module scope, agent B's `content_block_start` at index 0
 * replaced agent A's pending entry: A's `tool_use` came out under B's name with
 * both agents' argument fragments spliced together, and B's never came out.
 */
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapClaudeMessage, ToolBlockBuffer } from '../providers/claude/message-mapper.js';

const streamEvent = (event: Record<string, unknown>) =>
  ({ type: 'stream_event', event, session_id: 's1' }) as unknown as SDKMessage;

const start = (name: string, id: string) =>
  streamEvent({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', name, id },
  });
const delta = (partial_json: string) =>
  streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json },
  });
const stop = () => streamEvent({ type: 'content_block_stop', index: 0 });

describe('Claude tool_use streaming across concurrent agents', () => {
  it('assembles each stream from its own fragments', () => {
    const a = new ToolBlockBuffer();
    const b = new ToolBlockBuffer();

    mapClaudeMessage(start('read', 'tu_a'), undefined, a);
    mapClaudeMessage(start('invoke', 'tu_b'), undefined, b);
    mapClaudeMessage(delta('{"uri":"yaar://'), undefined, a);
    mapClaudeMessage(delta('{"action":'), undefined, b);
    mapClaudeMessage(delta('a"}'), undefined, a);
    mapClaudeMessage(delta('"close"}'), undefined, b);

    const doneA = mapClaudeMessage(stop(), undefined, a);
    const doneB = mapClaudeMessage(stop(), undefined, b);

    expect(doneA).toMatchObject({
      type: 'tool_use',
      toolName: 'read',
      toolUseId: 'tu_a',
      toolInput: { uri: 'yaar://a' },
    });
    expect(doneB).toMatchObject({
      type: 'tool_use',
      toolName: 'invoke',
      toolUseId: 'tu_b',
      toolInput: { action: 'close' },
    });

    const resultFor = (id: string) =>
      ({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
        },
        session_id: 's1',
      }) as unknown as SDKMessage;
    expect(mapClaudeMessage(resultFor('tu_a'), undefined, a)?.toolName).toBe('read');
    expect(mapClaudeMessage(resultFor('tu_b'), undefined, b)?.toolName).toBe('invoke');
  });
});
