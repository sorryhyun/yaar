import type { Task } from '../context-pool.js';

export interface QueuedTask {
  task: Task;
  timestamp: number;
}

export class MainQueuePolicy {
  private readonly maxQueueSize: number;
  private queue: QueuedTask[] = [];
  private processing = false;

  constructor(maxQueueSize: number) {
    this.maxQueueSize = maxQueueSize;
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
