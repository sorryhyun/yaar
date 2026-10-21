/**
 * `AgentSession.toolCallCount` — what the app tier reads on either side of a
 * `direct_message` to tell a reply that ended the turn from one sent mid-work
 * (issue #187, item 1; `AppTaskProcessor`, `repliedDirectly`).
 *
 * Messages to another agent are left out on purpose: the frame that announces one races
 * its own handler, so counting it could put the message after the mark it records.
 */
import { describe, it, expect } from 'bun:test';
import { AgentSession } from '../agents/agent-session.js';
import { windowSource } from '../agents/context.js';
import type { AITransport, StreamMessage } from '../providers/types.js';
import type { ConnectionId } from '../session/broadcast-center.js';

function scriptedProvider(frames: StreamMessage[]): AITransport {
  return {
    name: 'claude',
    providerType: 'claude',
    async isAvailable() {
      return true;
    },
    async *query(): AsyncIterable<StreamMessage> {
      yield* frames;
      yield { type: 'complete' };
    },
    async interrupt() {
      return { outcome: 'idle' as const };
    },
    async dispose() {},
  };
}

const tool = (toolName: string): StreamMessage => ({ type: 'tool_use', toolName });

describe('AgentSession.toolCallCount', () => {
  it('counts work tool calls across turns, and not messages to other agents', async () => {
    const session = new AgentSession('conn-tool-count' as ConnectionId);
    session.attachProvider(
      scriptedProvider([
        tool('mcp__app__query'),
        tool('mcp__messaging__direct_message'),
        tool('messaging:direct_message'),
        tool('mcp__app__command'),
        { type: 'text', content: 'done' },
      ]),
    );
    expect(session.toolCallCount()).toBe(0);

    const turn = () =>
      session.handleMessage('go', {
        role: 'app-0-pin-preview-m1',
        source: windowSource('0/pin-preview'),
        monitorId: '0',
        systemPromptOverride: 'APP',
      });
    await turn();
    expect(session.toolCallCount()).toBe(2);

    await turn();
    expect(session.toolCallCount()).toBe(4);
    await session.cleanup();
  });
});
