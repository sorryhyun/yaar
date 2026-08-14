import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextTape, monitorSource, windowSource } from '../agents/context.js';

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
