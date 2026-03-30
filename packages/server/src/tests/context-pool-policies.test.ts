import { describe, it, expect } from 'bun:test';
import { MonitorQueuePolicy } from '../agents/context-pool-policies/monitor-queue-policy.js';
import { WindowQueuePolicy } from '../agents/context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from '../agents/context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from '../agents/context-pool-policies/reload-cache-policy.js';
import { ContextTape, monitorSource } from '../agents/context.js';
import type { Task } from '../agents/pool-types.js';

describe('MonitorQueuePolicy', () => {
  it('preserves FIFO ordering', () => {
    const policy = new MonitorQueuePolicy(3);
    const t1: Task = { type: 'monitor', messageId: '1', content: 'a' };
    const t2: Task = { type: 'monitor', messageId: '2', content: 'b' };

    policy.enqueue(t1);
    policy.enqueue(t2);

    expect(policy.dequeue()?.task.messageId).toBe('1');
    expect(policy.dequeue()?.task.messageId).toBe('2');
  });

  it('enforces queue size limit checks', () => {
    const policy = new MonitorQueuePolicy(1);
    policy.enqueue({ type: 'monitor', messageId: '1', content: 'a' });
    expect(policy.canEnqueue()).toBe(false);
  });
});

describe('WindowQueuePolicy', () => {
  it('queues sequentially per key', () => {
    const policy = new WindowQueuePolicy();
    policy.enqueue('w1', { type: 'app', windowId: 'w1', messageId: '1', content: 'first' });
    policy.enqueue('w1', { type: 'app', windowId: 'w1', messageId: '2', content: 'second' });

    expect(policy.dequeue('w1')?.task.messageId).toBe('1');
    expect(policy.dequeue('w1')?.task.messageId).toBe('2');
  });
});

describe('ContextAssemblyPolicy', () => {
  it('formats open windows context with details', () => {
    const policy = new ContextAssemblyPolicy();
    const windows = policy.formatOpenWindows([
      {
        id: 'w-1',
        title: 'Notes',
        content: { renderer: 'markdown', data: '' },
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        locked: false,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'w-2',
        title: 'Chat',
        content: { renderer: 'iframe', data: '' },
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        locked: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(windows).toContain('yaar://windows/w-1 — Notes');
    expect(windows).toContain('yaar://windows/w-2 — Chat');
    expect(windows).toContain('<open_windows>');
  });

  it('includes monitor and current window in open_windows header', () => {
    const policy = new ContextAssemblyPolicy();
    const windows = policy.formatOpenWindows(
      [
        {
          id: 'chat',
          title: 'Chat',
          content: { renderer: 'iframe', data: '' },
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          locked: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      { monitorId: '0', currentWindowId: 'chat' },
    );
    expect(windows).toContain('monitor="0"');
    expect(windows).toContain('yaar://windows/chat — Chat (you)');
  });

  describe('buildWindowInitialContext with configurable maxTurns', () => {
    function buildTape(turnCount: number) {
      const tape = new ContextTape();
      for (let i = 1; i <= turnCount; i++) {
        tape.append('user', `User message ${i}`, monitorSource('0'));
        tape.append('assistant', `Assistant reply ${i}`, monitorSource('0'));
      }
      return tape;
    }

    it('defaults to 5 turns (10 messages) when no constructor arg is given', () => {
      const policy = new ContextAssemblyPolicy(); // default windowInitialMaxTurns = 5
      const tape = buildTape(8); // 16 messages total

      const context = policy.buildWindowInitialContext(tape);
      // Should include turns 4-8 (last 5 turns = 10 messages)
      expect(context).not.toContain('User message 3');
      expect(context).toContain('User message 4');
      expect(context).toContain('Assistant reply 8');
    });

    it('respects custom windowInitialMaxTurns from constructor', () => {
      const policy = new ContextAssemblyPolicy(2); // 2 turns = 4 messages
      const tape = buildTape(5); // 10 messages total

      const context = policy.buildWindowInitialContext(tape);
      // Should only include turns 4 and 5 (last 2 turns)
      expect(context).not.toContain('User message 3');
      expect(context).toContain('User message 4');
      expect(context).toContain('Assistant reply 5');
    });

    it('allows per-call override of maxTurns', () => {
      const policy = new ContextAssemblyPolicy(5); // default 5
      const tape = buildTape(10); // 20 messages

      // Override to 1 turn = 2 messages
      const context = policy.buildWindowInitialContext(tape, 1);
      expect(context).not.toContain('User message 9');
      expect(context).toContain('User message 10');
      expect(context).toContain('Assistant reply 10');
    });

    it('includes all messages when fewer turns than maxTurns', () => {
      const policy = new ContextAssemblyPolicy(10); // 10 turns
      const tape = buildTape(3); // only 3 turns = 6 messages

      const context = policy.buildWindowInitialContext(tape);
      expect(context).toContain('User message 1');
      expect(context).toContain('User message 2');
      expect(context).toContain('User message 3');
      expect(context).toContain('Assistant reply 3');
    });
  });
});

describe('ReloadCachePolicy', () => {
  it('generates friendly labels', () => {
    // Pass a minimal mock cache — only generateCacheLabel is tested here
    const policy = new ReloadCachePolicy({ findMatches: () => [], record: () => {} } as any);
    expect(
      policy.generateCacheLabel({ type: 'monitor', messageId: '1', content: 'app: moltbook' }),
    ).toBe('Open moltbook app');
    expect(
      policy.generateCacheLabel({
        type: 'app',
        windowId: 'w',
        messageId: '2',
        content: 'click button "Save" now',
      }),
    ).toBe('Click "Save"');
  });
});
