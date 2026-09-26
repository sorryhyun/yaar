/**
 * A push/pull queue: one side pushes whenever it has something, one reader
 * pulls with `await next()` and sleeps while the queue is empty.
 *
 * Three readers use it. The Claude SDK takes its prompt as an async iterable it
 * drains for the life of the process, so a turn pushes one message and the
 * generator wakes; `TurnRouter` hands each frame the pump reads to whichever
 * turn owns it; and the Codex read loop turns JSON-RPC notifications, which
 * arrive as events, back into the stream a turn yields.
 *
 * Close semantics, the same for all three:
 *
 * - Items pushed before `close()` still drain; the reader sees done only after
 *   the last of them. A pull already waiting when the channel closes wakes and
 *   sees done, so nothing sleeps on a channel that will never be pushed again.
 * - A push after `close()` is dropped. Nobody reads a closed channel on purpose,
 *   and an item that is delivered or not depending on whether the reader has
 *   already noticed the close is worse than one that is never delivered.
 *
 * Single reader: `iterable` is one generator, and two consumers pulling from it
 * would each see a share of the items.
 */

export interface InputChannel<T> {
  /** Queue an item for the reader. Dropped once the channel is closed. */
  push(item: T): void;
  /** End the channel behind whatever is already queued. Idempotent. */
  close(): void;
  /** True once `close()` ran or an item matching `isLast` was pushed. */
  readonly closed: boolean;
  /** The channel's one reader. */
  readonly iterable: AsyncGenerator<T, void, undefined>;
}

export interface InputChannelOptions<T> {
  /**
   * An item that ends the stream it belongs to: it is delivered, and the channel
   * closes behind it.
   *
   * This is what lets a reader loop know nothing about where the stream ends.
   * The Codex loop used to decide turn end twice — the mapper by the type it gave
   * a notification, the loop by the raw method name — and the two disagreed on
   * `error` with `willRetry` (see `codex/errors.ts`). With the decision made
   * once, on the item the reader is about to yield, there is no second copy to
   * disagree.
   */
  isLast?: (item: T) => boolean;
}

export function createInputChannel<T>(options: InputChannelOptions<T> = {}): InputChannel<T> {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  async function* iterate(): AsyncGenerator<T, void, undefined> {
    for (;;) {
      while (buffer.length === 0) {
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      yield buffer.shift() as T;
    }
  }

  return {
    push(item) {
      if (closed) return;
      buffer.push(item);
      if (options.isLast?.(item)) closed = true;
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    get closed() {
      return closed;
    },
    iterable: iterate(),
  };
}
