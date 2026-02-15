import { describe, it, expect } from 'vitest';
import { MainQueuePolicy } from '../agents/context-pool-policies/main-queue-policy.js';
import { WindowQueuePolicy } from '../agents/context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from '../agents/context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from '../agents/context-pool-policies/reload-cache-policy.js';
import { WindowConnectionPolicy } from '../agents/context-pool-policies/window-connection-policy.js';
import { ContextTape } from '../agents/context.js';
import type { Task } from '../agents/pool-context.js';

describe('MainQueuePolicy', () => {
  it('preserves FIFO ordering', () => {
    const policy = new MainQueuePolicy(3);
    const t1: Task = { type: 'main', messageId: '1', content: 'a' };
    const t2: Task = { type: 'main', messageId: '2', content: 'b' };

    policy.enqueue(t1);
    policy.enqueue(t2);

    expect(policy.dequeue()?.task.messageId).toBe('1');
    expect(policy.dequeue()?.task.messageId).toBe('2');
  });

  it('enforces queue size limit checks', () => {
    const policy = new MainQueuePolicy(1);
    policy.enqueue({ type: 'main', messageId: '1', content: 'a' });
    expect(policy.canEnqueue()).toBe(false);
  });
});

describe('WindowQueuePolicy', () => {
  it('queues sequentially per key', () => {
    const policy = new WindowQueuePolicy();
    policy.enqueue('w1', { type: 'window', windowId: 'w1', messageId: '1', content: 'first' });
    policy.enqueue('w1', { type: 'window', windowId: 'w1', messageId: '2', content: 'second' });

    expect(policy.dequeue('w1')?.task.messageId).toBe('1');
    expect(policy.dequeue('w1')?.task.messageId).toBe('2');
  });
});

describe('ContextAssemblyPolicy', () => {
  it('formats open windows context', () => {
    const policy = new ContextAssemblyPolicy();
    const windows = policy.formatOpenWindows(['w-1', 'w-2']);
    expect(windows).toContain('<open_windows>w-1, w-2</open_windows>');
  });

  describe('buildWindowInitialContext with configurable maxTurns', () => {
    function buildTape(turnCount: number) {
      const tape = new ContextTape();
      for (let i = 1; i <= turnCount; i++) {
        tape.append('user', `User message ${i}`, 'main');
        tape.append('assistant', `Assistant reply ${i}`, 'main');
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
      policy.generateCacheLabel({ type: 'main', messageId: '1', content: 'app: moltbook' }),
    ).toBe('Open moltbook app');
    expect(
      policy.generateCacheLabel({
        type: 'window',
        windowId: 'w',
        messageId: '2',
        content: 'click button "Save" now',
      }),
    ).toBe('Click "Save"');
  });
});

describe('WindowConnectionPolicy', () => {
  it('standalone window has no group', () => {
    const policy = new WindowConnectionPolicy();
    expect(policy.getGroupId('w1')).toBeUndefined();
    expect(policy.getRoot('w1')).toBeUndefined();
    expect(policy.getGroupWindows('w1')).toBeUndefined();
  });

  it('closing a standalone window disposes the agent', () => {
    const policy = new WindowConnectionPolicy();
    const result = policy.handleClose('w1');
    expect(result.shouldDisposeAgent).toBe(true);
    expect(result.newRoot).toBeUndefined();
  });

  it('connects child to parent, creating a group', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');

    // Both windows share the same group (rooted at A)
    expect(policy.getGroupId('A')).toBe('A');
    expect(policy.getGroupId('B')).toBe('A');
    expect(policy.getRoot('A')).toBe('A');
    expect(policy.getRoot('B')).toBe('A');

    const windows = policy.getGroupWindows('B');
    expect(windows).toBeDefined();
    expect(windows!.has('A')).toBe(true);
    expect(windows!.has('B')).toBe(true);
    expect(windows!.size).toBe(2);
  });

  it('closing non-root window keeps agent alive', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('A', 'C');

    const result = policy.handleClose('B');
    expect(result.shouldDisposeAgent).toBe(false);
    expect(result.newRoot).toBeUndefined(); // root didn't change

    // A and C remain
    expect(policy.getGroupWindows('A')!.size).toBe(2);
    expect(policy.getGroupId('B')).toBeUndefined();
  });

  it('closing root window promotes a child as new root', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('A', 'C');

    const result = policy.handleClose('A');
    expect(result.shouldDisposeAgent).toBe(false);
    // Deterministic: lexicographically first surviving window becomes root
    expect(result.newRoot).toBe('B');

    // The promoted root is now the group root
    expect(policy.getRoot('B')).toBe(result.newRoot);
    expect(policy.getRoot('C')).toBe(result.newRoot);

    // Group still exists with 2 windows
    expect(policy.getGroupWindows('B')!.size).toBe(2);
  });

  it('closing last window in group disposes the agent', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');

    policy.handleClose('A'); // root promotes to B
    const result = policy.handleClose('B'); // last window
    expect(result.shouldDisposeAgent).toBe(true);

    // Group is fully cleaned up
    expect(policy.getGroupId('A')).toBeUndefined();
    expect(policy.getGroupId('B')).toBeUndefined();
  });

  it('chains: A creates B, B creates C — all in same group', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('B', 'C'); // B is already in A's group

    // All three windows share group A
    expect(policy.getGroupId('A')).toBe('A');
    expect(policy.getGroupId('B')).toBe('A');
    expect(policy.getGroupId('C')).toBe('A');
    expect(policy.getGroupWindows('A')!.size).toBe(3);
  });

  it('deep chain: D created by C keeps same group', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('B', 'C');
    policy.connectWindow('C', 'D');

    expect(policy.getGroupId('D')).toBe('A');
    expect(policy.getGroupWindows('A')!.size).toBe(4);
  });

  it('multiple independent groups remain separate', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('X', 'Y');

    expect(policy.getGroupId('A')).toBe('A');
    expect(policy.getGroupId('B')).toBe('A');
    expect(policy.getGroupId('X')).toBe('X');
    expect(policy.getGroupId('Y')).toBe('X');

    // Closing B doesn't affect group X
    policy.handleClose('B');
    expect(policy.getGroupWindows('X')!.size).toBe(2);
    expect(policy.getGroupWindows('A')!.size).toBe(1);
  });

  it('getGroupWindows returns a copy (not a reference)', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');

    const windows = policy.getGroupWindows('A')!;
    windows.add('Z'); // mutate the copy
    expect(policy.getGroupWindows('A')!.has('Z')).toBe(false);
  });

  it('clear resets all state', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('A', 'C');

    policy.clear();

    expect(policy.getGroupId('A')).toBeUndefined();
    expect(policy.getGroupId('B')).toBeUndefined();
    expect(policy.getGroupId('C')).toBeUndefined();
  });

  it('root promotion works correctly after multiple closes', () => {
    const policy = new WindowConnectionPolicy();
    policy.connectWindow('A', 'B');
    policy.connectWindow('A', 'C');

    // Close root A → promotes one of B/C (2 remain)
    const r1 = policy.handleClose('A');
    expect(r1.shouldDisposeAgent).toBe(false);
    const newRoot1 = r1.newRoot!;

    // Close the promoted root → promotes the last one
    const r2 = policy.handleClose(newRoot1);
    expect(r2.shouldDisposeAgent).toBe(false);
    const newRoot2 = r2.newRoot!;

    // One window remains
    const remaining = policy.getGroupWindows(newRoot2)!;
    expect(remaining.size).toBe(1);

    // Close the last one
    const r3 = policy.handleClose(newRoot2);
    expect(r3.shouldDisposeAgent).toBe(true);
  });
});
