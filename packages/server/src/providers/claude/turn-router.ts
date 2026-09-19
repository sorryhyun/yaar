/**
 * Who a frame on the persistent stream belongs to.
 *
 * A turn used to *be* its reader: `runPersistentTurn` pushed a message and then pulled
 * `stream.next()` until the result. That holds only while YAAR is the one thing that can
 * start a turn. With Remote Control on, claude.ai can too — the CLI runs a turn nobody in
 * YAAR asked for, and its frames either sit unread until YAAR's next turn swallows them
 * as its own (ending at the stranger's `result`), or, once something reads the stream
 * continuously, arrive with no turn to put them in. So one pump reads the stream, and this
 * decides where each frame goes.
 *
 * Ownership is decided by uuid, at the turn boundary. Every message YAAR pushes carries a
 * uuid (`markOwn`), and the CLI announces the command a turn is running with
 * `command_lifecycle: started` naming it. A started command YAAR pushed while one of its
 * turns is reading is that turn's; anything else is **detached** — a claude.ai message, or
 * a YAAR steer that missed its turn and ran on its own — and becomes an external turn.
 * Ownership moves only between turns: a message the CLI folds into a running turn also
 * gets a `started`, and must not split that turn's frames in two.
 *
 * With Remote Control off nothing is ever detached, and a frame with no reader waits in
 * the backlog for the next turn — which is exactly what reading the stream from inside
 * the turn used to do with it.
 */

import { createInputChannel, type InputChannel } from './input-channel.js';

/** A turn the CLI is running that no YAAR turn is reading. */
export interface DetachedTurn {
  /** What was asked, if the CLI replayed it; the claude.ai user's own text. */
  prompt: string | undefined;
  /** Raw SDK frames, ending with the turn's `result`. */
  frames: AsyncIterable<unknown>;
}

interface RoutedFrame {
  type?: string;
  subtype?: string;
  state?: string;
  command_uuid?: string;
  isReplay?: boolean;
  isSynthetic?: boolean;
  user_message_uuids?: string[];
  message?: { content?: unknown };
}

interface DetachedState {
  prompt: string | undefined;
  channel: InputChannel;
  announced: boolean;
}

/** Idle frames kept for the next turn. A backlog only holds stragglers; this is a leak guard. */
const BACKLOG_LIMIT = 500;

/** Frames that are a turn's substance, as opposed to status the CLI emits around turns. */
function isTurnContent(f: RoutedFrame): boolean {
  return f.type === 'stream_event' || f.type === 'assistant' || f.type === 'result';
}

/** The text of a replayed user message — plain string or the text blocks of an array. */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown };
    // A replayed tool result is the model's own loop, not what somebody asked.
    if (b.type === 'tool_result') return undefined;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

export class TurnRouter {
  private readonly ownUuids = new Set<string>();
  private owner: 'turn' | 'detached' | null = null;
  private inbox: InputChannel | null = null;
  private inboxUuid: string | null = null;
  private backlog: unknown[] = [];
  private detached: DetachedState | null = null;
  private ended = false;

  constructor(
    private readonly opts: {
      /** Whether a turn nobody in YAAR is reading can exist at all (Remote Control on). */
      detachable: () => boolean;
      /** A detached turn has started. Called once per turn, with its frames still arriving. */
      onDetached: (turn: DetachedTurn) => void;
    },
  ) {}

  /** Record a message YAAR is about to push, so the turn it starts is recognised as ours. */
  markOwn(uuid: string): void {
    this.ownUuids.add(uuid);
  }

  /**
   * Start reading as the YAAR turn for `uuid`. Frames that arrived with nobody reading
   * come first — that is where a pull-per-turn reader would have found them.
   */
  openTurn(uuid: string): InputChannel {
    const inbox = createInputChannel();
    for (const frame of this.backlog) inbox.push(frame);
    this.backlog = [];
    this.inbox = inbox;
    this.inboxUuid = uuid;
    // Nothing will ever be routed here again; a reader must see the end, not wait for it.
    if (this.ended) inbox.close();
    return inbox;
  }

  /** The YAAR turn stopped reading. Idempotent; a stale inbox is ignored. */
  closeTurn(inbox: InputChannel): void {
    if (this.inbox !== inbox) return;
    this.inbox = null;
    this.inboxUuid = null;
    if (this.owner === 'turn') this.owner = null;
  }

  /** A turn the CLI is running belongs to no YAAR reader. */
  get detachedActive(): boolean {
    return this.owner === 'detached';
  }

  route(frame: unknown): void {
    const f = (frame ?? {}) as RoutedFrame;

    if (
      this.owner === null &&
      f.type === 'command_lifecycle' &&
      f.state === 'started' &&
      f.command_uuid
    ) {
      if (this.inbox && this.ownUuids.has(f.command_uuid)) this.owner = 'turn';
      else if (this.opts.detachable()) this.owner = 'detached';
    }

    // No lifecycle frame to go by (an older CLI, or one that stopped sending it): the
    // reader, if there is one, gets it — the pre-pump behaviour — and otherwise a
    // content frame on a detachable session opens a detached turn.
    let target = this.owner;
    if (target === null) {
      if (this.inbox) target = 'turn';
      else if (this.opts.detachable() && isTurnContent(f)) target = this.owner = 'detached';
    }

    if (target === 'turn' && this.inbox) this.inbox.push(frame);
    else if (target === 'detached') this.toDetached(f, frame);
    else if (this.backlog.length < BACKLOG_LIMIT) this.backlog.push(frame);

    if (f.type === 'result') this.endTurn(f, frame, target);
  }

  /** The stream is gone: wake every reader so none waits forever. */
  end(): void {
    this.ended = true;
    this.inbox?.close();
    this.inbox = null;
    this.detached?.channel.close();
    this.detached = null;
    this.owner = null;
  }

  private toDetached(f: RoutedFrame, frame: unknown): void {
    let turn = this.detached;
    if (!turn) {
      turn = this.detached = { prompt: undefined, channel: createInputChannel(), announced: false };
    }
    if (turn.prompt === undefined && f.type === 'user' && f.isReplay && !f.isSynthetic) {
      turn.prompt = promptText(f.message?.content);
    }
    turn.channel.push(frame);
    // Held back until the prompt is known, so the turn is announced with what was asked —
    // but not past the first model output, which is when a user would expect to see it.
    if (!turn.announced && (turn.prompt !== undefined || isTurnContent(f))) {
      turn.announced = true;
      this.opts.onDetached({ prompt: turn.prompt, frames: turn.channel.iterable });
    }
  }

  private endTurn(f: RoutedFrame, frame: unknown, target: typeof this.owner): void {
    const answered = f.user_message_uuids ?? [];
    if (target === 'detached') {
      this.detached?.channel.close();
      this.detached = null;
      // A YAAR message the CLI folded into the stranger's turn was answered there. Its
      // reader would otherwise wait for a result that already went by.
      if (this.inbox && this.inboxUuid && answered.includes(this.inboxUuid)) {
        this.inbox.push(frame);
      }
    }
    for (const uuid of answered) this.ownUuids.delete(uuid);
    this.owner = null;
  }
}
