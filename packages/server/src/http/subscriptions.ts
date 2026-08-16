/**
 * Subscription registry for reactive verb results.
 *
 * Iframe apps can subscribe to yaar:// URIs and receive push notifications
 * when the underlying data changes. The registry tracks active subscriptions
 * and emits events via actionEmitter when changes are detected.
 *
 * Matching is by literal URI string (exact, or a walk up the path for prefix
 * subscriptions), so both sides have to be written in real app ids — see
 * `checkResolved` below for the contract that used to be convention.
 */

import { ServerEventType, type StreamFrame } from '@yaar/shared';
import { actionEmitter } from '../session/action-emitter.js';
import { namesSelf } from './access.js';
import { recordDeliveredFrame } from '../streams/stream-diagnostics.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('subscriptions');

/**
 * A subscription is either a change *ping* (`'change'` — the callback gets a URI
 * string and re-reads) or a *stream* (`'stream'` — the server pushes typed
 * {@link StreamFrame}s with payloads). The two share this registry and the
 * `/api/verb/subscribe` endpoint; only the delivery differs.
 */
export type SubscriptionMode = 'change' | 'stream';

export interface Subscription {
  id: string;
  token: string;
  windowId: string;
  sessionId: string;
  uri: string;
  mode: SubscriptionMode;
  /** Stream-only: deliver only frames whose `kind` is listed. Undefined = all. */
  kinds?: string[];
  /** Stream-only: monotonic frame counter; a gap the consumer sees means a drop. */
  seq: number;
}

/**
 * Payload cap for a single stream frame.
 *
 * Sized for the payload that actually needs the room: a terminal `done` frame
 * carrying a sub-agent's whole final answer. A cap replaces the *entire* payload
 * with a marker rather than trimming a field, so a cap set to the size of a
 * routine progress frame turns every long answer into a frame that says nothing
 * (see `StreamToEventMapper.finish`). 32 KB holds a few thousand words of model
 * output, which is the real upper end of one turn's text.
 *
 * Raising it does not raise throughput: deltas coalesce against this same bound
 * (see {@link deltaFitsFrame}), so a bigger cap ships the same bytes in fewer,
 * larger frames rather than more of them.
 */
export const MAX_FRAME_PAYLOAD_CHARS = 32_768;

/**
 * Kinds whose frames carry an incremental `{ delta: string }` and may be merged.
 *
 * The agent token firehose emits `text` and `thinking` frame-per-token; a slow
 * iframe cannot keep up with that, so we fold the deltas that arrive inside one
 * {@link COALESCE_MS} tick into a single frame. Merging is *lossless* (the deltas
 * concatenate), so unlike a drop it does not create a `seq` gap — the merged
 * frame burns exactly one `seq`. Discrete kinds (`tool`, `progress`, `done`,
 * `error`) are never merged; they deliver immediately.
 */
const COALESCABLE_KINDS = new Set(['text', 'thinking']);

/** Coalescing tick — deltas arriving within this window merge into one frame. */
const COALESCE_MS = 60;

/** `{"delta":""}` — the fixed cost of the envelope a merged delta ships in. */
const DELTA_ENVELOPE_CHARS = 12;

/**
 * Would `{ delta }` survive {@link capPayload} intact?
 *
 * A coalesced delta must never reach the cap. Every other frame kind is a
 * self-contained payload, so truncating one costs the consumer that frame; a
 * delta is a *fragment of an accumulation*, so truncating one puts a silent hole
 * in the middle of the string the consumer is building and every later delta
 * lands after the gap. Flushing early is lossless, which is why the buffer is
 * bounded by the wire cap rather than by a round number of its own: whatever
 * still fits goes out now and the rest starts a fresh frame.
 *
 * The cheap bound comes first because this runs per provider chunk: JSON
 * escaping can at most double a string of ordinary model text, so anything under
 * half the cap is certainly safe and is never serialized twice. Only the last
 * couple of chunks before the flush pay for the exact measurement.
 */
function deltaFitsFrame(merged: string): boolean {
  if (merged.length * 2 + DELTA_ENVELOPE_CHARS <= MAX_FRAME_PAYLOAD_CHARS) return true;
  return JSON.stringify({ delta: merged }).length <= MAX_FRAME_PAYLOAD_CHARS;
}

/**
 * Cut an over-long accumulation into frame-sized pieces, keeping the tail that
 * still has room to grow as `remainder`.
 *
 * The pieces are found by binary search rather than by a fixed fraction of the
 * cap because the escape ratio is content-dependent: ASCII prose costs 1× and a
 * run of control characters costs 6×, so any constant either splits ordinary
 * text far too eagerly or fails to save the pathological case. The search only
 * runs on the chunk that actually overflows, which for a token stream is roughly
 * one chunk per 4 KB of output.
 */
function splitForFrames(merged: string): { ready: string[]; remainder: string } {
  if (deltaFitsFrame(merged)) return { ready: [], remainder: merged };
  const ready: string[] = [];
  let rest = merged;
  while (!deltaFitsFrame(rest)) {
    // `lo` never drops below 1, so every pass consumes at least one character
    // and the loop cannot spin: no single character escapes past the cap.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (deltaFitsFrame(rest.slice(0, mid))) lo = mid;
      else hi = mid - 1;
    }
    ready.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  return { ready, remainder: rest };
}

/** Per-subscription coalescing state: pending merged delta per coalescable kind. */
interface CoalesceState {
  /** kind → { source uri, accumulated delta } awaiting the next flush. */
  pending: Map<string, { uri: string; delta: string }>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Extract a string `delta` from a coalescable frame's payload, if present. */
function deltaOf(data: unknown): string | null {
  if (data && typeof data === 'object' && 'delta' in data) {
    const d = (data as { delta: unknown }).delta;
    if (typeof d === 'string') return d;
  }
  return null;
}

/**
 * Bound a frame payload. A stream is a firehose pointed at a possibly-slow
 * iframe, so an oversized payload is truncated to a marker rather than shipped.
 */
function capPayload(data: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  if (json === undefined) return data; // e.g. a bare `undefined`
  if (json.length <= MAX_FRAME_PAYLOAD_CHARS) return data;
  return { truncated: true, chars: json.length, preview: json.slice(0, MAX_FRAME_PAYLOAD_CHARS) };
}

let counter = 0;

/**
 * The registry's one contract, now checked instead of trusted.
 *
 * Subscriptions are keyed by literal URI string, so a subscription stored under
 * `yaar://apps/self/storage/` can never match the `yaar://apps/notes/storage/x.json`
 * a producer notifies with — and vice versa. Both sides must speak in real ids.
 * `/api/verb/subscribe` resolves `self` before storing (see `resolveSelf` in
 * http/access.ts), and every producer already passes a resolved URI, but nothing
 * said so and the failure mode is invisible: a subscription that simply never fires.
 *
 * The two boundaries answer differently on purpose:
 *
 * - `subscribe` **throws**. It has one caller, which resolves `self` and refuses
 *   what it cannot resolve, so a throw here is a backstop for a future second
 *   caller — and storing an unmatchable key is worse than failing the request.
 * - `notifyChange`/`publishFrame` **log and carry on**. A producer that reached one
 *   of them has already done the work it is announcing; throwing would report
 *   failure for a write that succeeded. Delivery would find no subscriber either
 *   way, so what this adds is that the miss is now visible in the log rather than
 *   silent.
 */
function checkResolved(uri: string, method: string): boolean {
  if (!namesSelf(uri)) return true;
  log.error(
    'given an unresolved "self" URI. Subscriptions are keyed by literal string, so this can ' +
      "never match a producer's real-id URI — resolve it against the caller's appId first " +
      '(resolveSelf in http/access.ts).',
    { method, uri },
  );
  return false;
}

class SubscriptionRegistry {
  private subscriptions = new Map<string, Subscription>();
  private uriIndex = new Map<string, Set<string>>();
  private windowIndex = new Map<string, Set<string>>();
  private sessionIndex = new Map<string, Set<string>>();
  /** Stream-only coalescing buffers, keyed by subscription id. */
  private coalescing = new Map<string, CoalesceState>();

  /** Register a subscription and return its id. `uri` must be fully resolved. */
  subscribe(
    token: string,
    windowId: string,
    sessionId: string,
    uri: string,
    mode: SubscriptionMode = 'change',
    kinds?: string[],
  ): string {
    // A key nothing can ever match is worse than a refused request — see checkResolved.
    if (!checkResolved(uri, 'subscribe')) {
      throw new Error(`Cannot subscribe to an unresolved "self" URI: ${uri}`);
    }
    const id = `sub-${Date.now()}-${++counter}`;
    const sub: Subscription = { id, token, windowId, sessionId, uri, mode, kinds, seq: 0 };
    this.subscriptions.set(id, sub);

    this.addToIndex(this.uriIndex, uri, id);
    this.addToIndex(this.windowIndex, windowId, id);
    this.addToIndex(this.sessionIndex, sessionId, id);

    return id;
  }

  unsubscribe(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;

    this.subscriptions.delete(id);
    this.removeFromIndex(this.uriIndex, sub.uri, id);
    this.removeFromIndex(this.windowIndex, sub.windowId, id);
    this.removeFromIndex(this.sessionIndex, sub.sessionId, id);

    // Drop any pending coalesced frames — the subscriber is gone; a timer that
    // fired now would emit to a dead subscription and leak the handle.
    const co = this.coalescing.get(id);
    if (co) {
      if (co.timer) clearTimeout(co.timer);
      this.coalescing.delete(id);
    }

    return true;
  }

  /**
   * Find all subscriptions where the subscription URI is a prefix of (or exact match to)
   * the changed URI. Walks up the URI path hierarchy instead of scanning all entries.
   */
  getSubscribers(uri: string): Subscription[] {
    const results: Subscription[] = [];

    // Check exact match
    this.collectFromIndex(uri, results);

    // Walk up the URI path to find prefix subscriptions
    let pos = uri.length;
    while (pos > 0) {
      pos = uri.lastIndexOf('/', pos - 1);
      if (pos < 0) break;
      const prefix = uri.slice(0, pos + 1);
      this.collectFromIndex(prefix, results);
      // Also check without trailing slash
      if (prefix.length > 1) {
        this.collectFromIndex(prefix.slice(0, -1), results);
      }
    }

    return results;
  }

  private collectFromIndex(uri: string, results: Subscription[]): void {
    const ids = this.uriIndex.get(uri);
    if (!ids) return;
    for (const id of ids) {
      const sub = this.subscriptions.get(id);
      if (sub) results.push(sub);
    }
  }

  clearForWindow(windowId: string): void {
    const ids = this.windowIndex.get(windowId);
    if (!ids) return;
    for (const id of [...ids]) {
      this.unsubscribe(id);
    }
  }

  clearForSession(sessionId: string): void {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return;
    for (const id of [...ids]) {
      this.unsubscribe(id);
    }
  }

  /**
   * Notify all subscribers watching a URI (or a parent prefix of it).
   * Emits events via actionEmitter so LiveSession can broadcast them to the frontend.
   *
   * `sessionId` scopes the notification to one session — pass it for URIs whose
   * data is per-session (windows, agents), so a change in session A doesn't wake
   * subscribers in session B. Omit it for session-independent URIs (app storage).
   */
  notifyChange(uri: string, sessionId?: string): void {
    checkResolved(uri, 'notifyChange');
    const subscribers = this.getSubscribers(uri);
    for (const sub of subscribers) {
      if (sub.mode !== 'change') continue; // stream subs receive frames, not pings
      if (sessionId && sub.sessionId !== sessionId) continue;
      actionEmitter.emit('verb-subscription', {
        sessionId: sub.sessionId,
        event: {
          type: ServerEventType.VERB_SUBSCRIPTION_UPDATE,
          windowId: sub.windowId,
          subscriptionId: sub.id,
          uri,
        },
      });
    }
  }

  /**
   * Push a typed frame to every stream subscriber watching `uri` (or a parent
   * prefix of it). Mirrors {@link notifyChange} but carries a payload: per-sub
   * `seq` is bumped, the payload is size-capped, and a `kinds` filter drops
   * frames the subscriber didn't ask for.
   *
   * `sessionId` scopes the frame to one session — pass it for per-session
   * sources (agents, windows, dev jobs) so session A's frames don't leak to B.
   */
  publishFrame(uri: string, kind: string, data: unknown, sessionId?: string): void {
    checkResolved(uri, 'publishFrame');
    const subscribers = this.getSubscribers(uri);
    for (const sub of subscribers) {
      if (sub.mode !== 'stream') continue;
      if (sessionId && sub.sessionId !== sessionId) continue;
      if (sub.kinds && !sub.kinds.includes(kind)) continue;
      this.enqueueFrame(sub, uri, kind, data);
    }
  }

  /**
   * Route one frame for a matched subscription: merge `text`/`thinking` deltas on
   * a tick (Guard 1), deliver everything else immediately. A discrete frame first
   * flushes any pending deltas so the consumer never sees a `tool` frame jump
   * ahead of the `text` that preceded it.
   */
  private enqueueFrame(sub: Subscription, uri: string, kind: string, data: unknown): void {
    const delta = COALESCABLE_KINDS.has(kind) ? deltaOf(data) : null;
    if (delta === null) {
      this.flushCoalesced(sub); // preserve ordering: pending deltas go out first
      this.deliverFrame(sub, uri, kind, data);
      return;
    }

    let co = this.coalescing.get(sub.id);
    if (!co) {
      co = { pending: new Map(), timer: null };
      this.coalescing.set(sub.id, co);
    }
    const prev = co.pending.get(kind);

    // Bound the buffer by the wire cap, losslessly: whatever no longer fits one
    // frame ships now and the rest keeps accumulating. Splitting rather than
    // waiting for the tick is what keeps a merged delta from reaching
    // `capPayload` — see {@link deltaFitsFrame} for why truncating one is not an
    // option the consumer can recover from.
    const { ready, remainder } = splitForFrames((prev?.delta ?? '') + delta);
    for (const piece of ready) {
      this.deliverFrame(sub, uri, kind, { delta: piece });
    }
    if (remainder) co.pending.set(kind, { uri, delta: remainder });
    else co.pending.delete(kind);

    if (!co.timer && remainder) {
      co.timer = setTimeout(() => this.flushCoalesced(sub), COALESCE_MS);
    }
  }

  /** Emit every pending coalesced delta for a subscription as one frame per kind. */
  private flushCoalesced(sub: Subscription): void {
    const co = this.coalescing.get(sub.id);
    if (!co) return;
    if (co.timer) {
      clearTimeout(co.timer);
      co.timer = null;
    }
    const pending = co.pending;
    co.pending = new Map();
    // The subscription may have been torn down between schedule and fire.
    if (!this.subscriptions.has(sub.id)) {
      this.coalescing.delete(sub.id);
      return;
    }
    for (const [kind, { uri, delta }] of pending) {
      this.deliverFrame(sub, uri, kind, { delta });
    }
  }

  /** Assign the next `seq`, cap the payload, and emit the frame to its subscriber. */
  private deliverFrame(sub: Subscription, uri: string, kind: string, data: unknown): void {
    const frame: StreamFrame = {
      uri,
      seq: ++sub.seq,
      kind,
      data: capPayload(data),
      ts: Date.now(),
    };
    // The post-coalescing half of the cadence measurement — count and timing of
    // what actually went on the wire. Pairs with `recordSourceDelta` at the
    // mapper; see stream-diagnostics.ts. Off unless explicitly enabled.
    recordDeliveredFrame(sub.id, kind, deltaOf(data)?.length ?? 0);
    actionEmitter.emit('verb-subscription', {
      sessionId: sub.sessionId,
      event: {
        type: ServerEventType.STREAM_FRAME,
        windowId: sub.windowId,
        subscriptionId: sub.id,
        frame,
      },
    });
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(id);
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) index.delete(key);
  }
}

export const subscriptionRegistry = new SubscriptionRegistry();

/** URI whose subscribers watch the session's agent roster. */
export const AGENTS_URI = 'yaar://session/agents';

/**
 * Notify subscribers that the session's agents changed — one was created,
 * disposed, or flipped between busy and idle.
 */
export function notifyAgentsChanged(sessionId: string): void {
  subscriptionRegistry.notifyChange(AGENTS_URI, sessionId);
}
