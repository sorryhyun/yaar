/**
 * The final block of a turn — the text after its last tool call — is handed to
 * `onContextMessage` beside the whole response, and is what a `hook: "response"` carries
 * back to the monitor.
 *
 * The whole response interleaves narration written between tool calls ("Recompiled. Now
 * checking…") with the report, and the monitor that asked had to dig the report out. The
 * context tape still gets every block.
 */
import { describe, it, expect } from 'bun:test';
import { StreamToEventMapper } from '../agents/session-policies/stream-to-event-mapper.js';
import type { StreamMessage } from '../providers/types.js';
import type { ContextSource } from '../agents/context.js';

function run(messages: StreamMessage[]) {
  const calls: { content: string; finalBlock?: string }[] = [];
  const mapper = new StreamToEventMapper({
    role: 'app-demo-m0-agent-msg1',
    providerName: 'claude',
    state: { responseText: '', thinkingText: '', currentMessageId: null },
    sendEvent: async () => {},
    logger: null,
    source: 'yaar://windows/0/demo' as ContextSource,
    monitorId: '0',
    onContextMessage: (role, content, finalBlock) => {
      if (role === 'assistant') calls.push({ content, finalBlock });
    },
  });
  return (async () => {
    for (const m of messages) await mapper.map(m);
    return calls;
  })();
}

const text = (content: string) => ({ type: 'text', content }) as StreamMessage;
const tool = (toolName: string) =>
  ({ type: 'tool_use', toolName, toolUseId: toolName, toolInput: {} }) as StreamMessage;
const complete = { type: 'complete', content: '' } as StreamMessage;

describe('onContextMessage finalBlock', () => {
  it('is the text after the last tool call, beside the whole response', async () => {
    const calls = await run([
      text('Compiling now.'),
      tool('compile'),
      text('Recompiled. Checking the console.'),
      tool('console'),
      text('Report: it works.'),
      complete,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].finalBlock).toBe('Report: it works.');
    expect(calls[0].content).toContain('Compiling now.');
    expect(calls[0].content).toContain('Report: it works.');
  });

  it('is absent when the turn ended on a tool call', async () => {
    const calls = await run([text('Here is the report.'), tool('notify'), complete]);
    expect(calls[0].finalBlock).toBeUndefined();
    expect(calls[0].content).toBe('Here is the report.');
  });

  it('is the whole text when no tool was called', async () => {
    const calls = await run([text('Just an answer.'), complete]);
    expect(calls[0].finalBlock).toBe('Just an answer.');
  });
});
