import type { QueuedTask, Task } from '../pool-types.js';

export class MonitorQueuePolicy {
  private readonly maxQueueSize: number;
  private queue: QueuedTask[] = [];
  private processing = false;
  private suspended = false;

  constructor(maxQueueSize: number) {
    this.maxQueueSize = maxQueueSize;
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  canEnqueue(): boolean {
    return this.queue.length < this.maxQueueSize;
  }

  enqueue(task: Task): number {
    const item = { task, timestamp: Date.now() };
    this.queue.push(item);
    return this.queue.length;
  }

  dequeue(): QueuedTask | undefined {
    if (this.suspended) return undefined;
    return this.queue.shift();
  }

  size(): number {
    return this.queue.length;
  }

  /**
   * Drop every queued task and hand them back.
   *
   * The tasks are returned rather than swallowed because each one is a message the user
   * sent and the client is still showing as "queued (position 3)". Clearing the queue on a
   * reset used to delete them where nobody could see it, and that chip never moved again.
   * A caller that discards work now has the work in its hands, and no excuse not to say so.
   */
  clear(): QueuedTask[] {
    const dropped = this.queue;
    this.queue = [];
    this.processing = false;
    return dropped;
  }

  beginProcessing(): boolean {
    if (this.processing) return false;
    this.processing = true;
    return true;
  }

  endProcessing(): void {
    this.processing = false;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}
