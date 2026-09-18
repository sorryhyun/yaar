import { describe, it, expect } from 'bun:test';
import { MonitorQueuePolicy } from '../agents/context-pool-policies/monitor-queue-policy.js';
import { MonitorTaskProcessor } from '../agents/monitor-task-processor.js';
import type { MonitorPoolContext } from '../agents/pool-types.js';

describe('MonitorTaskProcessor.processMonitorQueue', () => {
  // A suspended queue holds its items but dequeues nothing. The drain used to loop on
  // `size() > 0` regardless, spinning synchronously and freezing the whole event loop.
  it('returns when the queue is suspended with work pending', async () => {
    const queue = new MonitorQueuePolicy(20);
    queue.enqueue({ requestedType: 'monitor', kind: 'user', messageId: 'm1', content: 'hi' });
    queue.suspend();

    const ctx = {
      getOrCreateMonitorQueue: () => queue,
      agentPool: { isMonitorAgentBusy: () => false },
    } as unknown as MonitorPoolContext;

    await new MonitorTaskProcessor(ctx).processMonitorQueue('0');

    expect(queue.size()).toBe(1);
    // The drain released its processing claim, so resume can drain again.
    expect(queue.beginProcessing()).toBe(true);
  });
});
