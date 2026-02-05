import { ContextTape } from '../agents/context.js';
import { getContextRestoreMessages, type ContextRestorePolicy } from '../logging/context-restore.js';
import { parseSessionMessages } from '../logging/session-reader.js';

function makeSessionJsonl(): string {
  return [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      agentId: 'main-a1',
      parentAgentId: null,
      source: 'main',
      content: 'main question',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      agentId: 'main-a1',
      parentAgentId: null,
      source: 'main',
      content: 'main answer',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      agentId: 'window-w1',
      parentAgentId: 'default',
      source: { window: 'w1' },
      content: 'w1 ask',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:03.000Z',
      agentId: 'window-w1',
      parentAgentId: 'default',
      source: { window: 'w1' },
      content: 'w1 answer',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:04.000Z',
      agentId: 'window-w2',
      parentAgentId: 'default',
      source: { window: 'w2' },
      content: 'w2 ask',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:05.000Z',
      agentId: 'window-w2',
      parentAgentId: 'default',
      source: { window: 'w2' },
      content: 'w2 answer',
    }),
  ].join('\n');
}

describe('context restore pipeline', () => {

  it('infers window source from legacy agentId when source metadata is missing', () => {
    const legacyJsonl = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        agentId: 'window-legacy',
        parentAgentId: 'default',
        content: 'legacy question',
      }),
    ].join('\n');

    const restored = getContextRestoreMessages(parseSessionMessages(legacyJsonl));
    expect(restored).toHaveLength(1);
    expect(restored[0].source).toEqual({ window: 'legacy' });
  });
  it('restores full multi-window history and preserves source + timestamp after restart', () => {
    const messages = parseSessionMessages(makeSessionJsonl());
    const restored = getContextRestoreMessages(messages);

    expect(restored).toHaveLength(6);
    expect(restored[2].source).toEqual({ window: 'w1' });
    expect(restored[4].source).toEqual({ window: 'w2' });
    expect(restored[3].timestamp).toBe('2026-01-01T00:00:03.000Z');

    const tape = new ContextTape();
    tape.restore(restored);

    const promptForW1 = tape.formatForPrompt({ includeWindows: true, windowId: 'w1' });
    expect(promptForW1).toContain('<user:w1>w1 ask</user:w1>');
    expect(promptForW1).toContain('<assistant:w1>w1 answer</assistant:w1>');
    expect(promptForW1).not.toContain('w2 ask');

    const promptForW2 = tape.formatForPrompt({ includeWindows: true, windowId: 'w2' });
    expect(promptForW2).toContain('<user:w2>w2 ask</user:w2>');
    expect(promptForW2).toContain('<assistant:w2>w2 answer</assistant:w2>');
    expect(promptForW2).not.toContain('w1 ask');
  });

  it('supports restore policy for main + selected windows', () => {
    const messages = parseSessionMessages(makeSessionJsonl());
    const policy: ContextRestorePolicy = {
      mode: 'main_and_selected_windows',
      selectedWindowIds: ['w1'],
    };

    const restored = getContextRestoreMessages(messages, policy);
    expect(restored).toHaveLength(4);
    expect(restored.some((m) => typeof m.source === 'object' && m.source.window === 'w2')).toBe(false);
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
