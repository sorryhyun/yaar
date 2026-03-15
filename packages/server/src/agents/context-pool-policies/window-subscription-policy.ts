/**
 * WindowSubscriptionPolicy — agent-level window subscriptions.
 *
 * Allows agents (main or window) to subscribe to changes on specific windows.
 * When a subscribed window changes, the subscribing agent receives a synthetic
 * task describing what changed, delivered through the normal task pipeline.
 *
 * Debounces rapid changes (e.g., streaming appends) per subscription.
 * Skips self-notifications to prevent infinite loops.
 */

import type { WindowChangeEvent } from '@yaar/shared';
import type { Task } from '../pool-types.js';

export interface WindowSubscription {
  id: string;
  subscriberAgentKey: string;
  subscriberType: 'main' | 'window';
  subscriberWindowId?: string;
  subscriberMonitorId: string;
  targetWindowId: string;
  events: Set<WindowChangeEvent>;
  debounceMs: number;
}

interface PendingNotification {
  timer: ReturnType<typeof setTimeout>;
  event: WindowChangeEvent;
  summary: string;
}

const DEFAULT_DEBOUNCE_MS = 500;
let counter = 0;

export class WindowSubscriptionPolicy {
  private subscriptions = new Map<string, WindowSubscription>();
  /** targetWindowId → Set<subscriptionId> */
  private targetIndex = new Map<string, Set<string>>();
  /** subscriberAgentKey → Set<subscriptionId> */
  private agentIndex = new Map<string, Set<string>>();
  /** subscriptionId → pending debounced notification */
  private pending = new Map<string, PendingNotification>();

  subscribe(opts: {
    subscriberAgentKey: string;
    subscriberType: 'main' | 'window';
    subscriberWindowId?: string;
    subscriberMonitorId: string;
    targetWindowId: string;
    events: WindowChangeEvent[];
    debounceMs?: number;
  }): string {
    const id = `wsub-${Date.now()}-${++counter}`;
    const sub: WindowSubscription = {
      id,
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

  unsubscribe(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;

    this.cancelPending(id);
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
      if (!sub.events.has(event)) continue;
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

      this.pending.set(sub.id, { timer, event, summary });
    }
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
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
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

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
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
