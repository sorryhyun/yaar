import { ContextTape } from '../agents/context.js';

describe('ContextTape', () => {
  let tape: ContextTape;

  beforeEach(() => {
    tape = new ContextTape();
  });

  it('appends and retrieves messages', () => {
    tape.append('user', 'hello', 'main');
    tape.append('assistant', 'hi', 'main');

    expect(tape.length).toBe(2);
    const all = tape.getAllMessages();
    expect(all[0].role).toBe('user');
    expect(all[0].content).toBe('hello');
    expect(all[1].role).toBe('assistant');
  });

  describe('filtering', () => {
    beforeEach(() => {
      tape.append('user', 'main msg', 'main');
      tape.append('user', 'win1 msg', { window: 'w1' });
      tape.append('user', 'win2 msg', { window: 'w2' });
    });

    it('excludes window messages when includeWindows=false', () => {
      const msgs = tape.getMessages({ includeWindows: false });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('main msg');
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
      tape.append('user', 'main', 'main');
      tape.append('user', 'win msg', { window: 'w1' });
      tape.append('assistant', 'win reply', { window: 'w1' });

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
      tape.append('user', 'hello', 'main');
      tape.append('assistant', 'hi', 'main');

      const formatted = tape.formatForPrompt();
      expect(formatted).toContain('<user>hello</user>');
      expect(formatted).toContain('<assistant>hi</assistant>');
      expect(formatted).toContain('<previous_conversation>');
    });

    it('excludes window messages by default', () => {
      tape.append('user', 'main', 'main');
      tape.append('user', 'window', { window: 'w1' });

      const formatted = tape.formatForPrompt();
      expect(formatted).not.toContain('window');
    });

    it('includes specific window when requested', () => {
      tape.append('user', 'main', 'main');
      tape.append('user', 'win1', { window: 'w1' });

      const formatted = tape.formatForPrompt({ includeWindows: true, windowId: 'w1' });
      expect(formatted).toContain('user:w1');
      expect(formatted).toContain('win1');
    });
  });

  it('clear empties all messages', () => {
    tape.append('user', 'msg', 'main');
    tape.clear();
    expect(tape.length).toBe(0);
  });
});
