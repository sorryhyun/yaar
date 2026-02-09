/**
 * EventSequencer - Monotonic sequence stamping with ring buffer for replay.
 *
 * Every ServerEvent broadcast through a LiveSession gets a monotonic `seq` number.
 * Late-joining clients can request replay from their last-seen seq.
 */

import type { ServerEvent } from '@yaar/shared';

const DEFAULT_CAPACITY = 5000;

interface RingEntry {
  seq: number;
  event: ServerEvent;
}

export class EventSequencer {
  private nextSeq = 1;
  private ring: RingEntry[];
  private capacity: number;
  private head = 0; // next write position
  private count = 0; // entries currently stored

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.ring = new Array(capacity);
  }

  /**
   * Stamp an event with a monotonic sequence number and store it in the ring buffer.
   * Returns the event with `seq` attached.
   */
  stamp(event: ServerEvent): ServerEvent & { seq: number } {
    const seq = this.nextSeq++;
    const stamped = { ...event, seq };

    this.ring[this.head] = { seq, event: stamped };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }

    return stamped;
  }

  /**
   * Replay all events after a given sequence number.
   * Returns null if the requested seq is too old (fell off the ring buffer)
   * and the client needs a full snapshot instead.
   */
  replayAfter(lastSeq: number): ServerEvent[] | null {
    if (this.count === 0) return [];

    // Find the oldest seq in the ring
    const oldestIdx = this.count < this.capacity
      ? 0
      : this.head; // when full, head points to oldest
    const oldestEntry = this.ring[oldestIdx];
    if (!oldestEntry) return [];

    // If requested seq is older than our oldest stored event, need snapshot
    if (lastSeq < oldestEntry.seq - 1) {
      return null;
    }

    // Collect events after lastSeq
    const result: ServerEvent[] = [];
    const startIdx = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const idx = (startIdx + i) % this.capacity;
      const entry = this.ring[idx];
      if (entry && entry.seq > lastSeq) {
        result.push(entry.event);
      }
    }

    return result;
  }

  /** Get the current sequence number (last assigned). */
  getCurrentSeq(): number {
    return this.nextSeq - 1;
  }
}
