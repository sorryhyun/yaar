/**
 * One turn's escape-guard retry: the state between a tripwire trip and the
 * correction's answer.
 *
 * A trip interrupts the turn and pushes a correction onto the same stream, so
 * the retry stays one turn from the caller's point of view. That makes the
 * interrupted turn's own terminal something to swallow rather than yield — and,
 * when the CLI folds the correction into the interrupted command, the one
 * terminal that answers both. This class decides which; `session-provider.ts`
 * keeps the reading, yielding and sending.
 *
 * @see providers/claude/escape-tripwire.ts — the detector that trips it.
 */

import { randomUUID } from 'crypto';
import type { EscapeGuardRecord, StreamMessage } from '../types.js';
import { withDeadline } from '../deadline.js';
import {
  callTarget,
  EscapeTripwire,
  escapeCorrection,
  type CutOffCall,
} from './escape-tripwire.js';
import { createLogger } from '../../observability/log.js';

// The provider's own component: these lines read as part of its turn log.
const log = createLogger('ClaudeSessionProvider');

/**
 * How many times one turn may be restarted for escape-mangled tool arguments.
 *
 * One. The correction is pushed as a user message, so a model that ignores it
 * would otherwise trip, be corrected, and trip again for as long as it kept
 * escaping — burning a turn each time. After the retry the turn is allowed to
 * run to completion however it writes its arguments, and the `PreToolUse`
 * repair hook still fixes whatever lands.
 */
const MAX_ESCAPE_RETRIES = 1;

/**
 * How long a swallowed escape-retry terminal waits for the correction's answer
 * to begin before it is taken as the turn's real end.
 *
 * A CLI that folds the correction into the interrupted command answers both
 * with that one `result`. When the result says so (`user_message_uuids`) the
 * turn ends on it at once; this bound covers a CLI that does not, which would
 * otherwise leave the turn waiting on a stream with nothing more to send. Sized
 * for the gap before a fresh command's first frame, not for a whole answer.
 */
const ESCAPE_RETRY_IDLE_MS = 60_000;

/** Whether a `result` frame says it answered the message pushed with `uuid`. */
function answers(msg: unknown, uuid: string | undefined): boolean {
  const answered = (msg as { user_message_uuids?: unknown }).user_message_uuids;
  return uuid !== undefined && Array.isArray(answered) && answered.includes(uuid);
}

/**
 * Whether a frame is the escape correction running as a command of its own:
 * model output, or the CLI announcing it started `uuid`. Status frames between
 * commands are neither, and must not cancel the held terminal.
 */
function startsCorrection(msg: unknown, uuid: string | undefined): boolean {
  const f = msg as { type?: string; state?: string; command_uuid?: string };
  if (f.type === 'command_lifecycle') return f.state === 'started' && f.command_uuid === uuid;
  return f.type === 'stream_event' || f.type === 'assistant' || f.type === 'result';
}

/** Per turn: block indices restart with each assistant message. Not reusable across turns. */
export class EscapeRetry {
  private readonly tripwire = new EscapeTripwire();
  private retries = 0;
  // Calls issued this turn that have no result yet — what a trip's interrupt
  // cuts off along with the call it means to cancel.
  private readonly unanswered = new Map<string, CutOffCall>();
  // Set between "we interrupted" and "the interrupted turn's terminal arrived",
  // which is the one result message this turn must swallow rather than yield.
  private awaiting = false;
  // The correction's uuid: a `result` naming it answered the retry as well.
  private correctionUuid: string | undefined;
  // The swallowed terminal, kept until the correction's own answer begins —
  // if it never does, this was the turn's end after all. See ESCAPE_RETRY_IDLE_MS.
  private held: StreamMessage | null = null;
  private heldUntil = 0;

  /** Whether a terminal is being held for the correction's answer. */
  get holding(): boolean {
    return this.held !== null;
  }

  /** Whether the interrupted turn's terminal is due or held — the stream ending now loses it. */
  get inProgress(): boolean {
    return this.awaiting || this.held !== null;
  }

  /**
   * Wait for `next` until the held terminal's deadline. Resolves to that
   * terminal if the deadline passes first — the turn's real end after all —
   * else to `null`. Call only while `holding`.
   */
  async outlived(next: Promise<unknown>): Promise<StreamMessage | null> {
    const held = this.held;
    if (!held) return null;
    const arrived = await withDeadline(next, Math.max(0, this.heldUntil - Date.now())).then(
      () => true,
      () => false,
    );
    if (arrived) return null;
    log.warn('escape retry: the correction never started; ending on the held terminal', {
      type: held.type,
    });
    return held;
  }

  /** A frame arrived: the correction's own answer beginning releases the held terminal. */
  observeFrame(msg: unknown): void {
    if (this.held && startsCorrection(msg, this.correctionUuid)) this.held = null;
  }

  /**
   * Feed a raw frame to the tripwire while a retry is still allowed. A trip
   * counts as the turn's retry and returns the cancelled call's record; the
   * caller interrupts and then pushes `correction()`.
   */
  trip(msg: unknown): EscapeGuardRecord | null {
    if (
      this.awaiting ||
      this.retries >= MAX_ESCAPE_RETRIES ||
      (msg as { type?: string }).type !== 'stream_event'
    ) {
      return null;
    }
    const tripped = this.tripwire.observe((msg as { event?: unknown }).event);
    if (!tripped) return null;
    this.retries++;
    this.awaiting = true;
    log.warn('escaped-text tripwire; restarting turn', {
      tool: tripped.toolName,
      target: tripped.target,
    });
    return tripped;
  }

  /** The correction for `tripped`, under a fresh uuid a folded `result` will name. */
  correction(tripped: EscapeGuardRecord): { uuid: string; text: string } {
    this.correctionUuid = randomUUID();
    return {
      uuid: this.correctionUuid,
      text: escapeCorrection(tripped, [...this.unanswered.values()]),
    };
  }

  /**
   * Whether to swallow `mapped`, the interrupted turn's own terminal. Yielding
   * it would end the turn in the UI while the correction we already pushed is
   * about to start answering on the same stream — unless the CLI folded the
   * correction into the interrupted command, when this one result (`msg`)
   * answered both and nothing else is coming.
   */
  swallows(msg: unknown, mapped: StreamMessage): boolean {
    if (!this.awaiting || (mapped.type !== 'complete' && mapped.type !== 'error')) return false;
    this.awaiting = false;
    this.tripwire.reset();
    if (!answers(msg, this.correctionUuid)) {
      this.held = mapped;
      this.heldUntil = Date.now() + ESCAPE_RETRY_IDLE_MS;
      log.info('escape retry: held the interrupted turn terminal', { type: mapped.type });
      return true;
    }
    log.info('escape retry: correction folded into the interrupted turn', {
      type: mapped.type,
    });
    return false;
  }

  /** Track which calls are still waiting on a result, for the next trip's correction. */
  track(mapped: StreamMessage): void {
    if (mapped.type === 'tool_use' && mapped.toolUseId) {
      this.unanswered.set(mapped.toolUseId, {
        toolName: mapped.toolName ?? 'unknown',
        target: callTarget(mapped.toolInput),
      });
    } else if (mapped.type === 'tool_result' && mapped.toolUseId) {
      this.unanswered.delete(mapped.toolUseId);
    }
  }
}
