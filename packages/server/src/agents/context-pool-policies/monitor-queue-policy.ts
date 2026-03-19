import type { Task } from '../pool-types.js';

export interface QueuedTask {
  task: Task;
  timestamp: number;
}

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

  clear(): void {
    this.queue = [];
    this.processing = false;
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
