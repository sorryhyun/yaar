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
    const all = tape.getAllMessages();
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
      expect(tape.getAllMessages()[0].content).toBe('main');
    });
  });

  describe('formatForPrompt', () => {
    it('returns empty string for empty tape', () => {
      expect(tape.formatForPrompt()).toBe('');
    });

    it('formats main messages with role tags', () => {
      tape.append('user', 'hello', monitorSource('0'));
      tape.append('assistant', 'hi', monitorSource('0'));

      const formatted = tape.formatForPrompt();
      expect(formatted).toContain('<user>hello</user>');
      expect(formatted).toContain('<assistant>hi</assistant>');
      expect(formatted).toContain('<previous_conversation>');
    });

    it('excludes window messages by default', () => {
      tape.append('user', 'main', monitorSource('0'));
      tape.append('user', 'window', windowSource('w1'));

      const formatted = tape.formatForPrompt();
      expect(formatted).not.toContain('window');
    });

    it('includes specific window when requested', () => {
      tape.append('user', 'main', monitorSource('0'));
      tape.append('user', 'win1', windowSource('w1'));

      const formatted = tape.formatForPrompt({ includeWindows: true, windowId: 'w1' });
      expect(formatted).toContain('user:w1');
      expect(formatted).toContain('win1');
    });
  });

  it('clear empties all messages', () => {
    tape.append('user', 'msg', monitorSource('0'));
    tape.clear();
    expect(tape.length).toBe(0);
  });
});
