/**
 * Enqueue a task, or tell the client its queue is full — the one shape both queues refuse in.
 *
 * The monitor queue has had a bound and a refusal since it existed; the window queue had
 * neither, so a wedged app agent accumulated tasks without limit and without a word to the
 * user. Both now come through here, which makes "the queue is full" one sentence with one
 * event shape rather than two that could disagree about whether the message was taken.
 *
 * What is deliberately **not** shared is `why` — the second sentence. Collapsing the
 * wordings was proposed and rejected: "Monitor is suspended." says the queue will not drain
 * until someone resumes it, while "Please wait for current operations to complete." says it
 * is draining already. One sentence for both leaves the suspended case advising the user to
 * wait for something that is not going to happen. So the caller supplies it, and the two
 * queues share the mechanism without sharing the claim.
 */

import { ServerEventType, type ServerEvent } from '@yaar/shared';
import type { Task } from './pool-types.js';

export interface QueueAdmission {
  /** Whether the queue has room. */
  canEnqueue(): boolean;
  /** Append the task; returns its 1-based position. */
  enqueue(): number;
}

export interface EnqueueOrRejectOptions {
  sendEvent(event: ServerEvent): Promise<void>;
  queue: QueueAdmission;
  task: Task;
  /** The monitor to stamp the refusal with, so it lands on the desktop that asked. */
  monitorId?: string;
  /** The bound, named in the refusal — a limit the user cannot see is not feedback. */
  maxQueueSize: number;
  /** The refusal's second sentence. See the header for why this is not shared. */
  why: string;
  /**
   * Called with the queued position once the task is taken.
   *
   * The caller logs, rather than handing a pre-formatted string down here to be printed:
   * a shared helper writing the line would stamp its own module name onto two different
   * queues' events, which is exactly the drift `createLogger(component)` exists to stop.
   */
  onQueued(position: number): void;
}

/** Returns whether the task was taken. A `false` has already been reported to the client. */
export async function enqueueOrReject(opts: EnqueueOrRejectOptions): Promise<boolean> {
  const { sendEvent, queue, task, monitorId, maxQueueSize, why } = opts;

  if (!queue.canEnqueue()) {
    await sendEvent({
      type: ServerEventType.ERROR,
      error: `Message queue is full (${maxQueueSize} messages). ${why}`,
      messageId: task.messageId,
      ...(monitorId ? { monitorId } : {}),
    });
    return false;
  }

  const position = queue.enqueue();
  opts.onQueued(position);
  await sendEvent({
    type: ServerEventType.MESSAGE_QUEUED,
    messageId: task.messageId,
    position,
  });
  return true;
}
