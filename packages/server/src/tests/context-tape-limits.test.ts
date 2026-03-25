import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ContextTape,
  monitorSource,
  windowSource,
  isWindowSource,
  extractWindowId,
} from '../agents/context.js';

/**
 * MAX_MONITOR_MESSAGES is 200 (not exported), pruning keeps the most recent half (100).
 */
const MAX_MONITOR_MESSAGES = 200;

describe('ContextTape auto-pruning', () => {
  let tape: ContextTape;

  beforeEach(() => {
    tape = new ContextTape();
  });

  it('does not prune when below the limit', () => {
    for (let i = 0; i < MAX_MONITOR_MESSAGES - 1; i++) {
      tape.append(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, monitorSource('0'));
    }

    expect(tape.length).toBe(199);
    const all = tape.getAllMessages();
    expect(all[0].content).toBe('msg-0');
    expect(all[198].content).toBe('msg-198');
  });

  it('prunes to ~half when exceeding MAX_MONITOR_MESSAGES', () => {
    for (let i = 0; i < MAX_MONITOR_MESSAGES + 1; i++) {
      tape.append(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, monitorSource('0'));
    }

    // 201 main messages added; pruneIfNeeded keeps the most recent 100,
    // removing the oldest 101.
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2);
    expect(tape.length).toBe(keepCount);

    const all = tape.getAllMessages();
    // The oldest surviving message should be msg-101 (index 101 of original 201)
    expect(all[0].content).toBe(`msg-${MAX_MONITOR_MESSAGES + 1 - keepCount}`);
    // The newest should be the last appended
    expect(all[all.length - 1].content).toBe(`msg-${MAX_MONITOR_MESSAGES}`);
  });

  it('preserves window messages when main messages are pruned', () => {
    // Interleave window messages among main messages
    const windowContents: string[] = [];
    for (let i = 0; i < MAX_MONITOR_MESSAGES + 1; i++) {
      tape.append('user', `main-${i}`, monitorSource('0'));

      // Sprinkle window messages at regular intervals
      if (i % 50 === 0) {
        const winContent = `win-${i}`;
        windowContents.push(winContent);
        tape.append('user', winContent, windowSource('w1'));
      }
    }

    // Main messages should have been pruned
    const mainMessages = tape.getMessages({ includeWindows: false });
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2);
    expect(mainMessages).toHaveLength(keepCount);

    // All window messages must survive
    const windowMessages = tape
      .getAllMessages()
      .filter((m) => isWindowSource(m.source) && extractWindowId(m.source) === 'w1');
    expect(windowMessages).toHaveLength(windowContents.length);
    for (const expected of windowContents) {
      expect(windowMessages.some((m) => m.content === expected)).toBe(true);
    }
  });

  it('handles multiple pruning cycles correctly', () => {
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2); // 100

    // First cycle: add 201 messages to trigger pruning -> 100 remain
    for (let i = 0; i < MAX_MONITOR_MESSAGES + 1; i++) {
      tape.append('user', `batch1-${i}`, monitorSource('0'));
    }
    expect(tape.length).toBe(keepCount);

    // Second cycle: add another 101 messages to reach 201 again -> prunes to 100
    for (let i = 0; i < keepCount + 1; i++) {
      tape.append('assistant', `batch2-${i}`, monitorSource('0'));
    }
    expect(tape.length).toBe(keepCount);

    // Verify the most recent messages survived
    const all = tape.getAllMessages();
    expect(all[all.length - 1].content).toBe(`batch2-${keepCount}`);

    // None of batch1 should remain since batch2 filled the second half
    const hasBatch1 = all.some((m) => m.content.startsWith('batch1-'));
    expect(hasBatch1).toBe(false);
  });
});
