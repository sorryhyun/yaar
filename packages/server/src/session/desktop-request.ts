/**
 * Ask the desktop something, and park until it answers.
 *
 * Five things the server does to a browser have the same five steps: resolve which
 * session is being asked, mint an id, create a pending entry against that id, put the
 * question on the wire, and hand the caller an outcome that says whether an answer came
 * back. Dialogs, permission prompts, user prompts, clipboard reads and app-protocol
 * requests were each written out longhand, and the interesting part — what a *silence*
 * means to that particular caller — was buried in the repetition.
 *
 * {@link DesktopRequest} is those five steps once. What stays at the call site is the
 * question, the deadline, and the reading of the outcome; those are the parts that differ
 * and the parts that matter.
 *
 * Two rules are encoded here rather than left to each caller:
 *
 * - **No session is `cancelled`, not `timeout`.** A question that never reached a screen
 *   is not a screen that stayed silent, and a caller that waits out a full deadline for
 *   an undelivered question reads the silence as a refusal. So the ask settles now, and
 *   says so on the console rather than dropping it.
 * - **A late answer is remembered, not dropped.** With `graceMs`, an entry that expires
 *   leaves its metadata behind for a while, so a reply arriving afterwards can be *named*
 *   instead of merely unknown. What a late reply is worth is the caller's business (a
 *   dialog's "don't ask me again" is still a durable decision; an app's answer six
 *   seconds past its deadline is only a log line) — this just keeps it recognizable.
 */

import { PendingStore, type PendingOutcome } from './pending-store.js';

/**
 * How long an expired entry is remembered so a reply already on its way still counts.
 *
 * Generous on purpose: the cost of remembering is one small map entry, and the cost of
 * forgetting is a whole class of bug that presents three layers away as "the app is
 * broken" or "my saved permission did nothing".
 */
export const LATE_ANSWER_GRACE_MS = 5 * 60_000;

/**
 * One process-wide counter behind every id this module mints, so two kinds of request
 * created in the same millisecond cannot collide even where they share a prefix.
 */
let requestCounter = 0;

/** `{prefix}-{now}-{n}` — the id shape the frontend echoes back in its answer. */
export function mintRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++requestCounter}`;
}

/**
 * Say, once and loudly, that something could not be addressed.
 *
 * Dropping is deliberate: broadcasting to an arbitrary session puts a window on a
 * stranger's desktop, which is worse than not opening it. Dropping *silently* would be
 * worse than both, hence the error — the message names what was dropped because that is
 * what identifies the call site that needs a session threaded through it.
 */
export function reportUnaddressed(what: string): void {
  console.error(
    `[ActionEmitter] Dropped ${what}: no session in context and none passed. ` +
      'Frontend-directed emits must run inside an agent turn or an iframe verb call, ' +
      'or name their session explicitly.',
  );
}

/**
 * What one ask needs. `send` is the only part that touches the wire, and it runs *after*
 * the pending entry exists — so an answer that comes back on the same tick has something
 * to resolve.
 */
type AskOptions<TMeta> = {
  /** Who is being asked. `undefined` settles the ask as `cancelled` without sending. */
  sessionId: string | undefined;
  /** Already clamped by the caller — the deadline is theirs to choose and to report. */
  timeoutMs: number;
  /** Named in the console line when there is no session to ask. */
  what: string;
  /** Runs on the timeout path only, before the promise settles. */
  onExpire?: (id: string, meta: TMeta) => void;
  /** Put the question on the wire. */
  send: (id: string, sessionId: string) => void;
} & (TMeta extends void ? { meta?: undefined } : { meta: TMeta });

export class DesktopRequest<TResult, TMeta = void> {
  private store = new PendingStore<TResult, TMeta>();
  /** Expired entries, kept for `graceMs` so a late reply can be recognized. */
  private late = new Map<string, { meta: TMeta; expiredAt: number }>();
  private readonly prefix: string;
  private readonly graceMs: number;

  constructor(opts: { prefix: string; graceMs?: number }) {
    this.prefix = opts.prefix;
    this.graceMs = opts.graceMs ?? 0;
  }

  /**
   * Ask, and hand back an outcome that distinguishes "the desktop answered" from "the
   * desktop said nothing in time" from "there was no desktop to ask".
   */
  ask(opts: AskOptions<TMeta>): Promise<PendingOutcome<TResult>> {
    const meta = (opts as { meta?: TMeta }).meta as TMeta;

    if (!opts.sessionId) {
      reportUnaddressed(opts.what);
      return Promise.resolve({ ok: false, reason: 'cancelled' } as const);
    }
    const sessionId = opts.sessionId;

    const id = mintRequestId(this.prefix);
    // `PendingStore.create` makes `meta` required-or-forbidden by a conditional type on
    // `TMeta`, which cannot be satisfied from inside a generic. `AskOptions` re-states
    // the same condition, so the check has already happened at this method's own
    // signature; this restates the resulting shape rather than re-deriving it.
    const create = this.store.create.bind(this.store) as unknown as (
      id: string,
      opts: {
        timeoutMs: number;
        sessionId?: string;
        onExpire?: (id: string, meta: TMeta) => void;
        meta: TMeta;
      },
    ) => Promise<PendingOutcome<TResult>>;

    const pending = create(id, {
      timeoutMs: opts.timeoutMs,
      sessionId,
      onExpire: (expiredId, expiredMeta) => {
        this.remember(expiredId, expiredMeta);
        opts.onExpire?.(expiredId, expiredMeta);
      },
      meta,
    });

    opts.send(id, sessionId);
    return pending;
  }

  /**
   * Resolve a pending entry with the desktop's answer. `resolved: false` means the id is
   * no longer held — ask {@link takeLate} whether it was one of ours.
   */
  resolve(id: string, value: TResult): { resolved: boolean; meta?: TMeta } {
    return this.store.resolve(id, value);
  }

  /**
   * The metadata of an entry that expired recently, consumed on read. `undefined` means
   * the id is not one we expired inside the grace window — a duplicate reply, or one from
   * a session that is gone.
   */
  takeLate(id: string): TMeta | undefined {
    const entry = this.late.get(id);
    if (!entry) return undefined;
    this.late.delete(id);
    return entry.meta;
  }

  /**
   * Settle every entry belonging to a session as `cancelled`, so an awaiting tool
   * unblocks now rather than at its own deadline against a session that no longer exists.
   */
  clearForSession(sessionId: string): void {
    this.store.clearForSession(sessionId);
  }

  private remember(id: string, meta: TMeta): void {
    if (this.graceMs <= 0) return;
    const cutoff = Date.now() - this.graceMs;
    for (const [key, entry] of this.late) {
      if (entry.expiredAt < cutoff) this.late.delete(key);
    }
    this.late.set(id, { meta, expiredAt: Date.now() });
  }
}
