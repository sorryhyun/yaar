import { describe, it, expect } from 'vitest';
import { MainQueuePolicy } from '../agents/context-pool-policies/main-queue-policy.js';
import { WindowQueuePolicy } from '../agents/context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from '../agents/context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from '../agents/context-pool-policies/reload-cache-policy.js';
import type { Task } from '../agents/context-pool.js';

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
  it('formats interaction context and window context', () => {
    const policy = new ContextAssemblyPolicy();
    const interactions = [
      { type: 'click' as const, timestamp: Date.now(), windowTitle: 'X', details: 'Button A' },
      { type: 'draw' as const, timestamp: Date.now(), imageData: 'data:image/png;base64,abc' },
    ];

    const formatted = policy.formatInteractionsForContext(interactions);
    expect(formatted).toContain('<previous_interactions>');
    expect(formatted).toContain('<user_interaction:draw>');

    const windows = policy.formatOpenWindows(['w-1', 'w-2']);
    expect(windows).toContain('<open_windows>w-1, w-2</open_windows>');
  });
});

describe('ReloadCachePolicy', () => {
  it('generates friendly labels', () => {
    // Pass a minimal mock cache — only generateCacheLabel is tested here
    const policy = new ReloadCachePolicy({ findMatches: () => [], record: () => {} } as any);
    expect(policy.generateCacheLabel({ type: 'main', messageId: '1', content: 'app: moltbook' })).toBe('Open moltbook app');
    expect(policy.generateCacheLabel({ type: 'window', windowId: 'w', messageId: '2', content: 'click button "Save" now' })).toBe('Click "Save"');
  });
});
