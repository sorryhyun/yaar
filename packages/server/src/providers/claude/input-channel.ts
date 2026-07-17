/**
 * Push-based async channel feeding the Claude SDK's streaming input.
 *
 * The SDK takes the prompt as an async iterable it drains for the life of the
 * process. A turn needs to push one message into that iterable and have the
 * generator wake up — hence a channel rather than a generator over a fixed list.
 */

/** Push-based async channel feeding the SDK's streaming input. */
export interface InputChannel {
  push(message: unknown): void;
  close(): void;
  iterable: AsyncGenerator<unknown>;
}

export function createInputChannel(): InputChannel {
  const buffer: unknown[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  async function* iterate(): AsyncGenerator<unknown> {
    for (;;) {
      while (buffer.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      if (buffer.length === 0) return;
      yield buffer.shift();
    }
  }
  return {
    push(message) {
      buffer.push(message);
      notify?.();
    },
    close() {
      closed = true;
      notify?.();
    },
    iterable: iterate(),
  };
}
