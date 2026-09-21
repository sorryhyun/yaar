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
 * Used by the auto-pruning describe block below (merged from context-tape-limits.test.ts).
 */
const MAX_MONITOR_MESSAGES = 200;

describe('ContextTape', () => {
  let tape: ContextTape;

  beforeEach(() => {
    tape = new ContextTape();
  });

  it('appends and retrieves messages', () => {
    tape.append('user', 'hello', monitorSource('0'));
    tape.append('assistant', 'hi', monitorSource('0'));

    expect(tape.length).toBe(2);
    const all = tape.getMessages();
    expect(all[0].role).toBe('user');
    expect(all[0].content).toBe('hello');
    expect(all[1].role).toBe('assistant');
  });

  describe('filtering', () => {
    beforeEach(() => {
      tape.append('user', 'monitor msg', monitorSource('0'));
      tape.append('user', 'win1 msg', windowSource('w1'));
      tape.append('user', 'win2 msg', windowSource('w2'));
    });

    it('excludes window messages when includeWindows=false', () => {
      const msgs = tape.getMessages({ includeWindows: false });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('monitor msg');
    });

    it('filters by specific window IDs', () => {
      const msgs = tape.getMessages({ windowIds: ['w1'] });
      expect(msgs).toHaveLength(2); // main + w1
      expect(msgs.some((m) => m.content === 'win2 msg')).toBe(false);
    });

    it('excludes specific window IDs', () => {
      const msgs = tape.getMessages({ excludeWindowIds: ['w2'] });
      expect(msgs).toHaveLength(2); // main + w1
    });
  });

  describe('pruneWindow', () => {
    it('removes messages for a window and returns them', () => {
      tape.append('user', 'main', monitorSource('0'));
      tape.append('user', 'win msg', windowSource('w1'));
      tape.append('assistant', 'win reply', windowSource('w1'));

      const pruned = tape.pruneWindow('w1');
      expect(pruned).toHaveLength(2);
      expect(tape.length).toBe(1);
      expect(tape.getMessages()[0].content).toBe('main');
    });
  });

  describe('pruneMonitor', () => {
    beforeEach(() => {
      tape.append('user', 'm0 msg', monitorSource('0'));
      tape.append('user', 'm1 msg', monitorSource('1'));
      tape.append('user', 'w1 msg', windowSource('w1'));
      tape.append('assistant', 'w2 msg', windowSource('w2'));
    });

    it('removes the monitor and its own windows, and returns them', () => {
      const pruned = tape.pruneMonitor('0', (windowId) => windowId === 'w1');

      expect(pruned.map((m) => m.content)).toEqual(['m0 msg', 'w1 msg']);
      expect(tape.getMessages().map((m) => m.content)).toEqual(['m1 msg', 'w2 msg']);
    });

    it('keeps every window branch when the monitor owns none', () => {
      const pruned = tape.pruneMonitor('1', () => false);

      expect(pruned.map((m) => m.content)).toEqual(['m1 msg']);
      expect(tape.length).toBe(3);
    });
  });

  it('clear empties all messages', () => {
    tape.append('user', 'msg', monitorSource('0'));
    tape.clear();
    expect(tape.length).toBe(0);
  });
});

describe('ContextTape auto-pruning', () => {
  let pruningTape: ContextTape;

  beforeEach(() => {
    pruningTape = new ContextTape();
  });

  it('does not prune when below the limit', () => {
    for (let i = 0; i < MAX_MONITOR_MESSAGES - 1; i++) {
      pruningTape.append(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, monitorSource('0'));
    }

    expect(pruningTape.length).toBe(199);
    const all = pruningTape.getMessages();
    expect(all[0].content).toBe('msg-0');
    expect(all[198].content).toBe('msg-198');
  });

  it('prunes to ~half when exceeding MAX_MONITOR_MESSAGES', () => {
    for (let i = 0; i < MAX_MONITOR_MESSAGES + 1; i++) {
      pruningTape.append(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, monitorSource('0'));
    }

    // 201 main messages added; pruneIfNeeded keeps the most recent 100,
    // removing the oldest 101.
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2);
    expect(pruningTape.length).toBe(keepCount);

    const all = pruningTape.getMessages();
    // The oldest surviving message should be msg-101 (index 101 of original 201)
    expect(all[0].content).toBe(`msg-${MAX_MONITOR_MESSAGES + 1 - keepCount}`);
    // The newest should be the last appended
    expect(all[all.length - 1].content).toBe(`msg-${MAX_MONITOR_MESSAGES}`);
  });

  it('preserves window messages when main messages are pruned', () => {
    // Interleave window messages among main messages
    const windowContents: string[] = [];
    for (let i = 0; i < MAX_MONITOR_MESSAGES + 1; i++) {
      pruningTape.append('user', `main-${i}`, monitorSource('0'));

      // Sprinkle window messages at regular intervals
      if (i % 50 === 0) {
        const winContent = `win-${i}`;
        windowContents.push(winContent);
        pruningTape.append('user', winContent, windowSource('w1'));
      }
    }

    // Main messages should have been pruned
    const mainMessages = pruningTape.getMessages({ includeWindows: false });
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2);
    expect(mainMessages).toHaveLength(keepCount);

    // All window messages must survive
    const windowMessages = pruningTape
      .getMessages()
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
      pruningTape.append('user', `batch1-${i}`, monitorSource('0'));
    }
    expect(pruningTape.length).toBe(keepCount);

    // Second cycle: add another 101 messages to reach 201 again -> prunes to 100
    for (let i = 0; i < keepCount + 1; i++) {
      pruningTape.append('assistant', `batch2-${i}`, monitorSource('0'));
    }
    expect(pruningTape.length).toBe(keepCount);

    // Verify the most recent messages survived
    const all = pruningTape.getMessages();
    expect(all[all.length - 1].content).toBe(`batch2-${keepCount}`);

    // None of batch1 should remain since batch2 filled the second half
    const hasBatch1 = all.some((m) => m.content.startsWith('batch1-'));
    expect(hasBatch1).toBe(false);
  });
});
