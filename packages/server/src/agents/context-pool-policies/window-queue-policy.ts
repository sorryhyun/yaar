import type { Task } from '../pool-types.js';

export interface WindowQueuedTask {
  task: Task;
  timestamp: number;
}

export class WindowQueuePolicy {
  private processingKeys = new Map<string, boolean>();
  private queues = new Map<string, WindowQueuedTask[]>();

  isProcessing(key: string): boolean {
    return this.processingKeys.get(key) === true;
  }

  setProcessing(key: string, processing: boolean): void {
    this.processingKeys.set(key, processing);
  }

  enqueue(key: string, task: Task): number {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    queue.push({ task, timestamp: Date.now() });
    return queue.length;
  }

  dequeue(key: string): WindowQueuedTask | undefined {
    const queue = this.queues.get(key);
    return queue?.shift();
  }

  /** Drop one key's queued tasks and hand them back. See MonitorQueuePolicy.clear(). */
  clearQueue(key: string): WindowQueuedTask[] {
    const dropped = this.queues.get(key) ?? [];
    this.queues.delete(key);
    return dropped;
  }

  getQueueSize(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  getQueueSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const [key, queue] of this.queues.entries()) {
      if (queue.length > 0) sizes[key] = queue.length;
    }
    return sizes;
  }

  /** Drop every key's queued tasks and hand them back. See MonitorQueuePolicy.clear(). */
  clear(): WindowQueuedTask[] {
    const dropped = [...this.queues.values()].flat();
    this.processingKeys.clear();
    this.queues.clear();
    return dropped;
  }
}
