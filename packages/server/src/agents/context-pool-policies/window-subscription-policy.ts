/**
 * WindowSubscriptionPolicy — agent-level window subscriptions.
 *
 * Allows agents (monitor or app) to subscribe to:
 *  - **window changes** — content/interaction/close/… on a specific window, and
 *  - **app event channels** — declarative `app.emit(channel, payload)` pushes from
 *    an iframe app, and the server-side equivalent the YAAR Bridge raises for the
 *    real browser (a native dialog fired on a driven tab, a driven tab navigated).
 *
 * Both share the same registry, indexes, debounce, and close-teardown; only the
 * event key (a `WindowChangeEvent` enum vs. an arbitrary channel string) and the
 * task framing differ. Channel subscriptions additionally carry a delivery
 * `mode`: `wake` (deliver a task now, debounced) or `buffer` (append to the
 * agent's next turn without waking it).
 *
 * Debounces rapid changes (e.g., streaming appends) per subscription/channel.
 * Skips self-notifications to prevent infinite loops.
 */

import type { WindowChangeEvent } from '@yaar/shared';
import type { Task } from '../pool-types.js';

export type SubscriptionMode = 'wake' | 'buffer';

/**
 * Max serialized payload length delivered to an agent; larger is truncated.
 *
 * This is a *context budget*, not a wire limit — the body is injected into the
 * subscriber's prompt. It is set for the largest thing an app legitimately hands
 * an agent through a channel: the result of work the agent itself delegated
 * (devtools' worker sub-agent answering a survey). A cap sized for a progress
 * ping instead makes every delegated answer arrive gutted, and the agent cannot
 * tell a truncated finding from a thin one.
 *
 * ~16 KB is a few thousand tokens — affordable for an event that wakes an agent,
 * and still a hard stop on an app that emits prose in a loop. An app with more
 * to say than this should emit a handle and let the agent read it with a command,
 * where the ceiling is `MAX_TEXT_BYTES` (400 KB) rather than a prompt budget.
 */
export const MAX_PAYLOAD_CHARS = 16_384;

export interface WindowSubscription {
  id: string;
  /** `window` = window-change events; `channel` = app event channels. */
  kind: 'window' | 'channel';
  subscriberAgentKey: string;
  subscriberType: 'monitor' | 'app';
  subscriberWindowId?: string;
  subscriberMonitorId: string;
  targetWindowId: string;
  /** Window-change events (kind === 'window'). */
  events?: Set<WindowChangeEvent>;
  /** App event channels (kind === 'channel'); may contain '*' for all. */
  channels?: Set<string>;
  /** Delivery mode for channel subscriptions. */
  mode?: SubscriptionMode;
  debounceMs: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
let counter = 0;

/**
 * Frame an app event for prompt injection. Consistent with the existing
 * `<window:change>` / `<app_interaction>` framing.
 */
export function frameAppEvent(windowId: string, channel: string, payload: unknown): string {
  const body = fitPayload(payload, MAX_PAYLOAD_CHARS);
  return `<app:event window="${windowId}" channel="${channel}">\n${body}\n</app:event>`;
}

/** Room left beside the JSON for the note naming what was cut. */
const CUT_NOTE_RESERVE = 1024;
/** Most cut paths the note spells out before it summarizes the rest as a count. */
const MAX_NOTED_PATHS = 8;
/** A string is never cut below this while arrays still have items to give up. */
const MIN_STRING_CAP = 64;

interface Cut {
  path: string;
  /** Length before the cut: chars for a string, items for an array. */
  was: number;
  kind: 'string' | 'array';
}

/**
 * Serialize a payload into at most `max` chars, cutting by structure rather than by
 * position.
 *
 * The old cut kept the first `max` chars of the serialized JSON, which left the agent
 * holding half an object: the keys after the cut point gone and nothing saying which.
 * An app's payload is usually a small envelope around one or two long strings (a
 * worker's `{ kind, taskId, answer }`), so this shrinks long strings instead — all of
 * them to one shared cap, the largest that fits, so short fields arrive whole and the
 * envelope stays valid JSON. Each cut string ends in `…[cut, N chars]`, and a note
 * after the JSON lists the cut paths.
 *
 * Arrays give up their tails only when strings alone cannot make room (thousands of
 * short items). A payload that still does not fit — tens of thousands of keys — falls
 * back to the positional cut, labelled as such.
 */
export function fitPayload(payload: unknown, max: number): string {
  if (typeof payload === 'string') return fitString(payload, max);

  let full: string | undefined;
  try {
    full = JSON.stringify(payload ?? null);
  } catch {
    // Circular or a BigInt — no structure to preserve.
    return fitString(String(payload), max);
  }
  // A function or a symbol serializes to nothing.
  if (full === undefined) return String(payload);
  if (full.length <= max) return full;

  const value: unknown = JSON.parse(full);
  const budget = max - CUT_NOTE_RESERVE;

  const byStrings = largestFit(longestString(value), (cap) => shrink(value, cap, Infinity), budget);
  if (byStrings) return withCutNote(byStrings, full.length, max);

  const stringCap = Math.min(MIN_STRING_CAP, longestString(value));
  const byArrays = largestFit(
    longestArray(value),
    (cap) => shrink(value, stringCap, Math.max(1, cap)),
    budget,
  );
  if (byArrays) return withCutNote(byArrays, full.length, max);

  return `${full.slice(0, max)}… [truncated mid-JSON: ${full.length} chars, too many fields to cut by structure]`;
}

/** A plain string has no structure to keep, so it keeps its head. */
function fitString(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length} chars]`;
}

/**
 * Binary-search the largest cap in `[0, upper]` whose shrunk serialization fits in
 * `budget`. Null when even a cap of 0 does not.
 */
function largestFit(
  upper: number,
  shrinkAt: (cap: number) => { json: string; cuts: Cut[] },
  budget: number,
): { json: string; cuts: Cut[] } | null {
  let best = shrinkAt(0);
  if (best.json.length > budget) return null;
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const attempt = shrinkAt(mid);
    if (attempt.json.length <= budget) {
      best = attempt;
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Copy `value` with every string over `stringCap` and every array over `arrayCap` cut. */
function shrink(
  value: unknown,
  stringCap: number,
  arrayCap: number,
): { json: string; cuts: Cut[] } {
  const cuts: Cut[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (node.length <= stringCap) return node;
      cuts.push({ path, was: node.length, kind: 'string' });
      return `${node.slice(0, stringCap)}…[cut, ${node.length} chars]`;
    }
    if (Array.isArray(node)) {
      const kept = node.slice(0, arrayCap).map((item, i) => walk(item, `${path}[${i}]`));
      if (node.length > arrayCap) {
        cuts.push({ path, was: node.length, kind: 'array' });
        kept.push(`…[cut, ${node.length - arrayCap} more items]`);
      }
      return kept;
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child, joinPath(path, key));
      return out;
    }
    return node;
  };
  const json = JSON.stringify(walk(value, ''));
  return { json, cuts };
}

function joinPath(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length;
  const children = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];
  let longest = 0;
  for (const child of children) longest = Math.max(longest, longestString(child));
  return longest;
}

function longestArray(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  let longest = Array.isArray(value) ? value.length : 0;
  for (const child of children) longest = Math.max(longest, longestArray(child));
  return longest;
}

/** The JSON, then one line naming what was cut from it. */
function withCutNote(fit: { json: string; cuts: Cut[] }, fullChars: number, max: number): string {
  const named = fit.cuts
    .slice(0, MAX_NOTED_PATHS)
    .map(
      (c) =>
        `${c.path.slice(0, 80) || '(root)'} (${c.was} ${c.kind === 'string' ? 'chars' : 'items'})`,
    );
  const rest = fit.cuts.length - named.length;
  const note =
    `[truncated from ${fullChars} to fit ${max} chars — cut ${fit.cuts.length} ` +
    `field${fit.cuts.length === 1 ? '' : 's'}: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}]`;
  return `${fit.json}\n${note}`;
}

/** Frame a window-change event for prompt injection. Counterpart to `frameAppEvent`. */
function frameWindowChange(sub: WindowSubscription, event: WindowChangeEvent, summary: string) {
  return `<window:change windowId="${sub.targetWindowId}" event="${event}" subscriptionId="${sub.id}">\n${summary}\n</window:change>`;
}

export class WindowSubscriptionPolicy {
  private subscriptions = new Map<string, WindowSubscription>();
  /** targetWindowId → Set<subscriptionId> */
  private targetIndex = new Map<string, Set<string>>();
  /** subscriberAgentKey → Set<subscriptionId> */
  private agentIndex = new Map<string, Set<string>>();
  /**
   * Pending debounced deliveries, keyed by:
   *  - window subs: `subscriptionId`
   *  - channel subs: `subscriptionId::channel`
   */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(opts: {
    subscriberAgentKey: string;
    subscriberType: 'monitor' | 'app';
    subscriberWindowId?: string;
    subscriberMonitorId: string;
    targetWindowId: string;
    events: WindowChangeEvent[];
    debounceMs?: number;
  }): string {
    return this.registerSubscription({
      id: `wsub-${Date.now()}-${++counter}`,
      kind: 'window',
      subscriberAgentKey: opts.subscriberAgentKey,
      subscriberType: opts.subscriberType,
      subscriberWindowId: opts.subscriberWindowId,
      subscriberMonitorId: opts.subscriberMonitorId,
      targetWindowId: opts.targetWindowId,
      events: new Set(opts.events),
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    });
  }

  /** Subscribe an agent to an app's declared event channels. */
  subscribeChannels(opts: {
    subscriberAgentKey: string;
    subscriberType: 'monitor' | 'app';
    subscriberWindowId?: string;
    subscriberMonitorId: string;
    targetWindowId: string;
    channels: string[];
    mode?: SubscriptionMode;
    debounceMs?: number;
  }): string {
    return this.registerSubscription({
      id: `csub-${Date.now()}-${++counter}`,
      kind: 'channel',
      subscriberAgentKey: opts.subscriberAgentKey,
      subscriberType: opts.subscriberType,
      subscriberWindowId: opts.subscriberWindowId,
      subscriberMonitorId: opts.subscriberMonitorId,
      targetWindowId: opts.targetWindowId,
      channels: new Set(opts.channels),
      mode: opts.mode ?? 'wake',
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    });
  }

  /** Store a built subscription and wire both indexes. Returns its id. */
  private registerSubscription(sub: WindowSubscription): string {
    this.subscriptions.set(sub.id, sub);
    this.addToIndex(this.targetIndex, sub.targetWindowId, sub.id);
    this.addToIndex(this.agentIndex, sub.subscriberAgentKey, sub.id);
    return sub.id;
  }

  unsubscribe(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;

    this.cancelPendingForSub(id);
    this.subscriptions.delete(id);
    this.removeFromIndex(this.targetIndex, sub.targetWindowId, id);
    this.removeFromIndex(this.agentIndex, sub.subscriberAgentKey, id);

    return true;
  }

  getSubscriptionsForWindow(windowId: string): WindowSubscription[] {
    const ids = this.targetIndex.get(windowId);
    if (!ids) return [];
    const results: WindowSubscription[] = [];
    for (const id of ids) {
      const sub = this.subscriptions.get(id);
      if (sub) results.push(sub);
    }
    return results;
  }

  /**
   * Notify subscribers of a window change.
   * Debounces per subscription. Skips self-notifications.
   */
  notifyChange(
    windowId: string,
    event: WindowChangeEvent,
    summary: string,
    sourceAgentKey: string | undefined,
    deliverTask: (task: Task) => void,
  ): void {
    const subs = this.getSubscriptionsForWindow(windowId);
    for (const sub of subs) {
      if (sub.kind !== 'window' || !sub.events?.has(event)) continue;
      // Skip self-notification
      if (sourceAgentKey && sub.subscriberAgentKey === sourceAgentKey) continue;

      this.cancelPending(sub.id);
      const framed = frameWindowChange(sub, event, summary);

      if (event === 'close') {
        // Close events are delivered immediately (no debounce — window is gone)
        deliverTask(this.buildNotifyTask(sub, 'sub-notify', framed));
        continue;
      }

      const timer = setTimeout(() => {
        this.pending.delete(sub.id);
        deliverTask(this.buildNotifyTask(sub, 'sub-notify', framed));
      }, sub.debounceMs);

      this.pending.set(sub.id, timer);
    }
  }

  /**
   * Notify subscribers of an app event on a channel.
   *
   * - `wake` subscriptions: deliver a task (debounced per subscription+channel).
   * - `buffer` subscriptions: hand the framed event to `bufferEvent` for the
   *   agent's next turn (no wakeup, no debounce).
   *
   * Skips self-notifications. Returns the number of subscribers matched.
   */
  notifyChannel(
    windowId: string,
    channel: string,
    payload: unknown,
    sourceAgentKey: string | undefined,
    deliverTask: (task: Task) => void,
    bufferEvent: (sub: WindowSubscription, framedContent: string) => void,
  ): number {
    const subs = this.getSubscriptionsForWindow(windowId);
    let matched = 0;
    for (const sub of subs) {
      if (sub.kind !== 'channel' || !sub.channels) continue;
      if (!sub.channels.has('*') && !sub.channels.has(channel)) continue;
      // Skip self-notification (emit caused by the agent's own action)
      if (sourceAgentKey && sub.subscriberAgentKey === sourceAgentKey) continue;

      matched++;
      const framed = frameAppEvent(sub.targetWindowId, channel, payload);

      if (sub.mode === 'buffer') {
        bufferEvent(sub, framed);
        continue;
      }

      const key = `${sub.id}::${channel}`;
      this.cancelPending(key);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        deliverTask(this.buildNotifyTask(sub, 'app-event', framed));
      }, sub.debounceMs);
      this.pending.set(key, timer);
    }
    return matched;
  }

  clearForWindow(windowId: string): void {
    // Clear subscriptions targeting this window
    const targetIds = this.targetIndex.get(windowId);
    if (targetIds) {
      for (const id of [...targetIds]) {
        this.unsubscribe(id);
      }
    }

    // Clear subscriptions owned by agents in this window
    // (agent keys for window agents are the windowId or groupId)
    const agentIds = this.agentIndex.get(windowId);
    if (agentIds) {
      for (const id of [...agentIds]) {
        this.unsubscribe(id);
      }
    }
  }

  clearForAgent(agentKey: string): void {
    const ids = this.agentIndex.get(agentKey);
    if (!ids) return;
    for (const id of [...ids]) {
      this.unsubscribe(id);
    }
  }

  clear(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.subscriptions.clear();
    this.targetIndex.clear();
    this.agentIndex.clear();
  }

  /**
   * Build the task delivered to a subscriber. `prefix` namespaces the messageId
   * per notification kind (`sub-notify` for window changes, `app-event` for
   * channels); `content` is already framed by the caller. Called at *delivery*
   * time, so the `Date.now()` stamp reflects when the task was handed over.
   */
  private buildNotifyTask(sub: WindowSubscription, prefix: string, content: string): Task {
    return {
      requestedType: sub.subscriberType,
      kind: 'notify',
      messageId: `${prefix}-${sub.id}-${Date.now()}`,
      windowId: sub.subscriberWindowId,
      content,
      monitorId: sub.subscriberMonitorId,
    };
  }

  private cancelPending(key: string): void {
    const timer = this.pending.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  /** Cancel all pending deliveries for a subscription (window key + channel keys). */
  private cancelPendingForSub(id: string): void {
    const prefix = `${id}::`;
    for (const key of [...this.pending.keys()]) {
      if (key === id || key.startsWith(prefix)) this.cancelPending(key);
    }
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
