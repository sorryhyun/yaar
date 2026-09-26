/**
 * The window between "a turn is running" and "its own message is on the wire".
 *
 * Both providers mark a turn in flight before the message that starts it has
 * reached the model — Claude gates on its MCP servers connecting first, Codex
 * waits out the `turn/start` round trip — and a steer arriving in that window
 * has two ways to land in the wrong place:
 *
 * 1. **Ahead of the message it is meant to steer.** Written now, it reaches the
 *    model first and the conversation reads in the wrong order. So a steer waits
 *    for the turn to start ({@link TurnGate.waitForStart}).
 * 2. **As the next turn's opening line.** A turn that ended while the steer
 *    waited would otherwise hand the message to whatever runs next. So the wait
 *    is bound to the turn it began on: a different turn, or none, is a refusal.
 *
 * Both providers used to carry their own copy of this, and the Codex one raced
 * the wait against a `setTimeout` it never cleared. The wait here is bounded by
 * `withDeadline`, which clears its timer on every path, and a turn that ends
 * wakes its waiters at once instead of holding them for the full deadline.
 */

import { withDeadline } from './deadline.js';

interface TurnRecord<T> {
  started: boolean;
  ended: boolean;
  value: T | undefined;
  /** Settles on start or end, whichever comes first. Never rejects. */
  settled: Promise<void>;
  settle: () => void;
}

/** One turn's side of the gate, held by the code running that turn. */
export interface TurnHandle<T> {
  /** The turn's own message is on the wire; `value` is what a steer targets. */
  start(value: T): void;
  /** The turn is over. Idempotent, and a no-op for the gate once a newer turn began. */
  end(): void;
}

/** What a steer may target once {@link TurnGate.waitForStart} returns. */
export type SteerTarget<T> =
  | { ok: true; value: T }
  /**
   * `idle` — no turn in flight. `timeout` — the turn did not start within the
   * deadline. `ended` — the turn the wait began on is over, or was replaced.
   */
  | { ok: false; reason: 'idle' | 'timeout' | 'ended' };

export class TurnGate<T = void> {
  private turn: TurnRecord<T> | null = null;

  /** A turn is in flight: begun and not yet ended, whether or not it has started. */
  get active(): boolean {
    return this.turn !== null;
  }

  /** The in-flight turn's start value; undefined while idle or still starting. */
  get current(): T | undefined {
    return this.turn?.started ? this.turn.value : undefined;
  }

  /**
   * Mark a turn in flight. A turn still open from before is ended first, so a
   * steer waiting on it refuses rather than steering this one.
   */
  begin(): TurnHandle<T> {
    if (this.turn) this.finish(this.turn);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const record: TurnRecord<T> = {
      started: false,
      ended: false,
      value: undefined,
      settled,
      settle,
    };
    this.turn = record;
    return {
      start: (value) => {
        if (record.started || record.ended) return;
        record.value = value;
        record.started = true;
        record.settle();
      },
      end: () => this.finish(record),
    };
  }

  /** End whatever turn is in flight — for teardown that cannot wait for its runner. */
  reset(): void {
    if (this.turn) this.finish(this.turn);
  }

  /**
   * Wait (at most `ms`) for the in-flight turn to start, then return what to
   * steer — or why not to. Resolves at once when the turn has already started,
   * and as soon as it ends when it never does.
   */
  async waitForStart(ms: number): Promise<SteerTarget<T>> {
    const turn = this.turn;
    if (!turn) return { ok: false, reason: 'idle' };
    if (!turn.started && !turn.ended) {
      try {
        await withDeadline(turn.settled, ms);
      } catch {
        return { ok: false, reason: 'timeout' };
      }
    }
    if (this.turn !== turn || !turn.started || turn.ended) return { ok: false, reason: 'ended' };
    return { ok: true, value: turn.value as T };
  }

  private finish(record: TurnRecord<T>): void {
    record.ended = true;
    if (this.turn === record) this.turn = null;
    record.settle();
  }
}
