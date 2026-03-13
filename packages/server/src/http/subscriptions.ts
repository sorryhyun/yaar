/**
 * Subscription registry for reactive verb results.
 *
 * Iframe apps can subscribe to yaar:// URIs and receive push notifications
 * when the underlying data changes. The registry tracks active subscriptions
 * and emits events via actionEmitter when changes are detected.
 */

import { ServerEventType } from '@yaar/shared';
import { actionEmitter } from '../session/action-emitter.js';

export interface Subscription {
  id: string;
  token: string;
  windowId: string;
  sessionId: string;
  uri: string;
}

let counter = 0;

class SubscriptionRegistry {
  private subscriptions = new Map<string, Subscription>();
  private uriIndex = new Map<string, Set<string>>();
  private windowIndex = new Map<string, Set<string>>();
  private sessionIndex = new Map<string, Set<string>>();

  subscribe(token: string, windowId: string, sessionId: string, uri: string): string {
    const id = `sub-${Date.now()}-${++counter}`;
    const sub: Subscription = { id, token, windowId, sessionId, uri };
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
   */
  notifyChange(uri: string): void {
    const subscribers = this.getSubscribers(uri);
    for (const sub of subscribers) {
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
