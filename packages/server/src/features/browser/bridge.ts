/**
 * BridgeHub — the authoritative in-memory model of the connected YAAR Bridge extension.
 *
 * The `/bridge` WebSocket handlers (websocket/bridge-handlers.ts) WRITE this state; the
 * `yaar://browser/*` verb handlers (handlers/browser.ts) READ it. It is deliberately NOT a
 * `BrowserProvider` — Slice 1 (T1 Observe) only surfaces tab metadata; the provider that can
 * actuate tabs arrives in Slice 2. See `0607plan.md`.
 *
 * On every change the hub notifies `subscriptionRegistry` so subscribed apps re-read the feed.
 */

import type { BridgeTab, BridgeFidelity } from '@yaar/shared';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { isYaarOriginUrl } from './guards.js';

/** A tab as exposed on the `yaar://browser/*` surface — bridge tab + YAAR-specific annotation. */
export interface BrowserTab extends BridgeTab {
  /** True when this tab is YAAR's own tab (annotated, never hidden or blocked). */
  isSelf?: boolean;
}

export interface BridgeConnectionInfo {
  browser: { name: string; version: string };
  protocolVersion: number;
}

const CHANGED_URIS = ['yaar://browser', 'yaar://browser/tabs', 'yaar://browser/presence'] as const;

class BridgeHub {
  private connection: BridgeConnectionInfo | null = null;
  private tabs: BrowserTab[] = [];

  /** Called by the WS `open`/`hello` path once the extension identifies itself. */
  setConnection(info: BridgeConnectionInfo): void {
    this.connection = info;
    this.notify();
  }

  /** Called by the WS `close` path — the feed downgrades to disconnected. */
  clearConnection(): void {
    this.connection = null;
    this.tabs = [];
    this.notify();
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  getConnection(): BridgeConnectionInfo | null {
    return this.connection;
  }

  /** 'bridge' when the extension is connected, else 'os-signals' (the read-only floor). */
  getFidelity(): BridgeFidelity {
    return this.connection ? 'bridge' : 'os-signals';
  }

  /** Replace the tab snapshot. Annotates YAAR's own tab; notifies on change. */
  updateTabs(tabs: BridgeTab[]): void {
    const annotated: BrowserTab[] = tabs.map((t) =>
      isYaarOriginUrl(t.url) ? { ...t, isSelf: true } : t,
    );
    if (!tabsEqual(this.tabs, annotated)) {
      this.tabs = annotated;
      this.notify();
    }
  }

  getTabs(): BrowserTab[] {
    return this.tabs;
  }

  getTab(id: number): BrowserTab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  /** The active tab (first one flagged active), if any. */
  getActiveTab(): BrowserTab | undefined {
    return this.tabs.find((t) => t.active);
  }

  private notify(): void {
    for (const uri of CHANGED_URIS) subscriptionRegistry.notifyChange(uri);
  }
}

/** Shallow-compare tab snapshots to avoid notifying on no-op updates. */
function tabsEqual(a: BrowserTab[], b: BrowserTab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.url !== y.url ||
      x.title !== y.title ||
      x.active !== y.active ||
      x.audible !== y.audible ||
      x.isSelf !== y.isSelf
    ) {
      return false;
    }
  }
  return true;
}

let hub: BridgeHub | null = null;

/** The process-wide singleton bridge state. */
export function getBridgeHub(): BridgeHub {
  if (!hub) hub = new BridgeHub();
  return hub;
}
