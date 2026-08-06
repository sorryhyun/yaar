import { describe, it, expect } from 'bun:test';
import { ContextTape, monitorSource, windowSource, extractWindowId } from '../agents/context.js';
import {
  getContextRestoreMessages,
  type ContextRestorePolicy,
} from '../logging/context-restore.js';
import { parseSessionMessages } from '../logging/session-reader.js';

function makeSessionJsonl(): string {
  return [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      agentId: 'main-a1',
      parentAgentId: null,
      source: monitorSource('0'),
      content: 'main question',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      agentId: 'main-a1',
      parentAgentId: null,
      source: monitorSource('0'),
      content: 'main answer',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      agentId: 'window-w1',
      parentAgentId: 'default',
      source: windowSource('w1'),
      content: 'w1 ask',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:03.000Z',
      agentId: 'window-w1',
      parentAgentId: 'default',
      source: windowSource('w1'),
      content: 'w1 answer',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:04.000Z',
      agentId: 'window-w2',
      parentAgentId: 'default',
      source: windowSource('w2'),
      content: 'w2 ask',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:05.000Z',
      agentId: 'window-w2',
      parentAgentId: 'default',
      source: windowSource('w2'),
      content: 'w2 answer',
    }),
  ].join('\n');
}

describe('context restore pipeline', () => {
  it('restores full multi-window history and preserves source + timestamp after restart', () => {
    const messages = parseSessionMessages(makeSessionJsonl());
    const restored = getContextRestoreMessages(messages);

    expect(restored).toHaveLength(6);
    expect(restored[2].source).toBe(windowSource('w1'));
    expect(restored[4].source).toBe(windowSource('w2'));
    expect(restored[3].timestamp).toBe('2026-01-01T00:00:03.000Z');

    const tape = new ContextTape();
    tape.restore(restored);

    // The branches stay separate after the restore: asking for one window's history
    // never hands back the other's.
    const forW1 = tape.getMessages({ windowIds: ['w1'] }).map((m) => `${m.role}:${m.content}`);
    expect(forW1).toContain('user:w1 ask');
    expect(forW1).toContain('assistant:w1 answer');
    expect(forW1).not.toContain('user:w2 ask');

    const forW2 = tape.getMessages({ windowIds: ['w2'] }).map((m) => `${m.role}:${m.content}`);
    expect(forW2).toContain('user:w2 ask');
    expect(forW2).toContain('assistant:w2 answer');
    expect(forW2).not.toContain('user:w1 ask');
  });

  it('supports restore policy for monitor + selected windows', () => {
    const messages = parseSessionMessages(makeSessionJsonl());
    const policy: ContextRestorePolicy = {
      mode: 'monitor_and_selected_windows',
      selectedWindowIds: ['w1'],
    };

    const restored = getContextRestoreMessages(messages, policy);
    expect(restored).toHaveLength(4);
    expect(restored.some((m) => extractWindowId(m.source) === 'w2')).toBe(false);
  });

  it('supports branch summarization for old windows', () => {
    const messages = parseSessionMessages(makeSessionJsonl());
    const policy: ContextRestorePolicy = {
      mode: 'summarize_old_windows',
      activeWindowIds: ['w2'],
      summaryTextByWindow: {
        w1: 'Window w1 was about budget planning.',
      },
    };

    const restored = getContextRestoreMessages(messages, policy);

    expect(restored.some((m) => m.content === 'w1 ask')).toBe(false);
    expect(restored.some((m) => m.content.includes('[window_summary:w1]'))).toBe(true);
    expect(restored.some((m) => m.content === 'w2 ask')).toBe(true);
  });
});
