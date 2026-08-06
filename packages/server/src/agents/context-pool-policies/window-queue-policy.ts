import { MAX_QUEUE_SIZE } from '../../config.js';
import type { QueuedTask, Task } from '../pool-types.js';

export class WindowQueuePolicy {
  private readonly maxQueueSize: number;
  private processingKeys = new Map<string, boolean>();
  private queues = new Map<string, QueuedTask[]>();

  /**
   * Bounded per key, on the same limit as a monitor's queue.
   *
   * It was unbounded, and that was the one place in the pool where a user could keep
   * sending and never be told the work was not moving: an app agent wedged mid-turn (a
   * provider that never returns, an iframe that never answers) collects every later click
   * and message in that window, with no ceiling and no refusal. `MonitorQueuePolicy` has
   * had `canEnqueue` since it existed; the refusal both now go through is
   * `enqueueOrReject` in `agents/queue-refusal.ts`.
   */
  constructor(maxQueueSize: number = MAX_QUEUE_SIZE) {
    this.maxQueueSize = maxQueueSize;
  }

  isProcessing(key: string): boolean {
    return this.processingKeys.get(key) === true;
  }

  setProcessing(key: string, processing: boolean): void {
    this.processingKeys.set(key, processing);
  }

  /** Whether this key's queue has room. Per key — one wedged app must not refuse another. */
  canEnqueue(key: string): boolean {
    return (this.queues.get(key)?.length ?? 0) < this.maxQueueSize;
  }

  /** The bound, for the refusal wording. */
  get maxSize(): number {
    return this.maxQueueSize;
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

  dequeue(key: string): QueuedTask | undefined {
    const queue = this.queues.get(key);
    return queue?.shift();
  }

  /** Drop one key's queued tasks and hand them back. See MonitorQueuePolicy.clear(). */
  clearQueue(key: string): QueuedTask[] {
    const dropped = this.queues.get(key) ?? [];
    this.queues.delete(key);
    return dropped;
  }

  getQueueSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const [key, queue] of this.queues.entries()) {
      if (queue.length > 0) sizes[key] = queue.length;
    }
    return sizes;
  }

  /** Drop every key's queued tasks and hand them back. See MonitorQueuePolicy.clear(). */
  clear(): QueuedTask[] {
    const dropped = [...this.queues.values()].flat();
    this.processingKeys.clear();
    this.queues.clear();
    return dropped;
  }
}
