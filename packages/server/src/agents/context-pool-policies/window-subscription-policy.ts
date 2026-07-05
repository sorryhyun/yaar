/**
 * WindowSubscriptionPolicy — agent-level window subscriptions.
 *
 * Allows agents (monitor or app) to subscribe to:
 *  - **window changes** — content/interaction/close/… on a specific window, and
 *  - **app event channels** — declarative `app.emit(channel, payload)` pushes from
 *    an iframe app (see docs/app_events_subscribe_proposal.md).
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

/** Max serialized payload length delivered to an agent; larger is truncated. */
const MAX_PAYLOAD_CHARS = 4096;

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
  let body: string;
  try {
    body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  } catch {
    body = String(payload);
  }
  if (body.length > MAX_PAYLOAD_CHARS) {
    body = `${body.slice(0, MAX_PAYLOAD_CHARS)}… [truncated, ${body.length} chars]`;
  }
  return `<app:event window="${windowId}" channel="${channel}">\n${body}\n</app:event>`;
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
    const id = `wsub-${Date.now()}-${++counter}`;
    const sub: WindowSubscription = {
      id,
      kind: 'window',
      subscriberAgentKey: opts.subscriberAgentKey,
      subscriberType: opts.subscriberType,
      subscriberWindowId: opts.subscriberWindowId,
      subscriberMonitorId: opts.subscriberMonitorId,
      targetWindowId: opts.targetWindowId,
      events: new Set(opts.events),
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };

    this.subscriptions.set(id, sub);
    this.addToIndex(this.targetIndex, opts.targetWindowId, id);
    this.addToIndex(this.agentIndex, opts.subscriberAgentKey, id);

    return id;
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
    const id = `csub-${Date.now()}-${++counter}`;
    const sub: WindowSubscription = {
      id,
      kind: 'channel',
      subscriberAgentKey: opts.subscriberAgentKey,
      subscriberType: opts.subscriberType,
      subscriberWindowId: opts.subscriberWindowId,
      subscriberMonitorId: opts.subscriberMonitorId,
      targetWindowId: opts.targetWindowId,
      channels: new Set(opts.channels),
      mode: opts.mode ?? 'wake',
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };

    this.subscriptions.set(id, sub);
    this.addToIndex(this.targetIndex, opts.targetWindowId, id);
    this.addToIndex(this.agentIndex, opts.subscriberAgentKey, id);

    return id;
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

      if (event === 'close') {
        // Close events are delivered immediately (no debounce — window is gone)
        deliverTask(this.buildTask(sub, event, summary));
        continue;
      }

      const timer = setTimeout(() => {
        this.pending.delete(sub.id);
        deliverTask(this.buildTask(sub, event, summary));
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
        deliverTask(this.buildChannelTask(sub, framed));
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

  private buildTask(sub: WindowSubscription, event: WindowChangeEvent, summary: string): Task {
    return {
      type: sub.subscriberType,
      messageId: `sub-notify-${sub.id}-${Date.now()}`,
      windowId: sub.subscriberWindowId,
      content: `<window:change windowId="${sub.targetWindowId}" event="${event}" subscriptionId="${sub.id}">\n${summary}\n</window:change>`,
      monitorId: sub.subscriberMonitorId,
    };
  }

  private buildChannelTask(sub: WindowSubscription, framedContent: string): Task {
    return {
      type: sub.subscriberType,
      messageId: `app-event-${sub.id}-${Date.now()}`,
      windowId: sub.subscriberWindowId,
      content: framedContent,
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
