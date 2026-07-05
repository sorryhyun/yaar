/**
 * BridgeHub — the authoritative in-memory model of the connected YAAR Bridge extension.
 *
 * The `/bridge` WebSocket handlers (websocket/bridge-handlers.ts) WRITE this state; the
 * `/api/bridge` dispatch layer (`features/browser/bridge-actions.ts`, driven by the `browser-user`
 * app) READS it. It is deliberately NOT a `BrowserProvider` — it traffics in tab metadata + a
 * correlated command socket, not CDP sessions. See `0607plan.md`.
 *
 * The `browser-user` app polls `/api/bridge` for the live feed, so the hub holds state only — it
 * does not push change notifications.
 */

import type {
  BridgeTab,
  BridgeFidelity,
  BridgeCommand,
  BridgeCommandResult,
  BridgeActivity,
} from '@yaar/shared';
import {
  BRIDGE_COMMAND_MIN_VERSION,
  BRIDGE_CONTENT_MIN_VERSION,
  BRIDGE_INTERACT_MIN_VERSION,
} from '@yaar/shared';
import { isYaarOriginUrl } from './guards.js';

/** Minimal socket surface the hub needs — just enough to write frames back to the extension. */
export interface BridgeSocket {
  send(data: string): void;
}

/** Outcome of a T2 command sent down the bridge (never throws — always resolves). */
export type CommandOutcome =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error: string };

/** How long to wait for a `command-result` before giving up on a bridge command. */
const COMMAND_TIMEOUT_MS = 10_000;

/** A tab as exposed on the `/api/bridge` surface — bridge tab + YAAR-specific annotation. */
export interface BrowserTab extends BridgeTab {
  /** True when this tab is YAAR's own tab (annotated, never hidden or blocked). */
  isSelf?: boolean;
}

export interface BridgeConnectionInfo {
  browser: { name: string; version: string };
  protocolVersion: number;
}

interface PendingCommand {
  resolve: (outcome: CommandOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BridgeHub {
  private connection: BridgeConnectionInfo | null = null;
  private tabs: BrowserTab[] = [];
  /** The live socket back to the extension — present only while connected. */
  private socket: BridgeSocket | null = null;
  /** In-flight T2 commands awaiting their correlated `command-result`. */
  private pending = new Map<number, PendingCommand>();
  private nextRequestId = 1;

  /** Called by the WS `hello` path once the extension identifies itself. */
  setConnection(info: BridgeConnectionInfo, socket: BridgeSocket): void {
    this.connection = info;
    this.socket = socket;
  }

  /** Called by the WS `close` path — the feed downgrades to disconnected. */
  clearConnection(): void {
    this.connection = null;
    this.socket = null;
    this.tabs = [];
    // Fail any in-flight commands — the extension that would answer them is gone.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'YAAR Bridge disconnected before the command completed.' });
    }
    this.pending.clear();
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

  /** Replace the tab snapshot. Annotates YAAR's own tab. */
  updateTabs(tabs: BridgeTab[]): void {
    const annotated: BrowserTab[] = tabs.map((t) =>
      isYaarOriginUrl(t.url) ? { ...t, isSelf: true } : t,
    );
    if (!tabsEqual(this.tabs, annotated)) {
      this.tabs = annotated;
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

  /**
   * Send a T2 command down the bridge and await the extension's correlated result.
   * Never throws — resolves to `{ ok: false, error }` on disconnect, old extension, or timeout,
   * so callers can surface a clean message. (T2 Manage — Slice 2.)
   */
  sendCommand(cmd: Omit<BridgeCommand, 'type' | 'requestId'>): Promise<CommandOutcome> {
    const conn = this.connection;
    if (!this.socket || !conn) {
      return Promise.resolve({
        ok: false,
        error: 'YAAR Bridge is not connected — no real browser to manage. Enable the extension.',
      });
    }
    // Newer verbs need newer extensions: `extract` needs content read; the T3 drive/view verbs
    // (click/type/scroll/navigate/screenshot) need the interaction floor above the T2 manage floor.
    const isInteract =
      cmd.action === 'click' ||
      cmd.action === 'type' ||
      cmd.action === 'scroll' ||
      cmd.action === 'navigate' ||
      cmd.action === 'screenshot';
    const minVersion =
      cmd.action === 'extract'
        ? BRIDGE_CONTENT_MIN_VERSION
        : isInteract
          ? BRIDGE_INTERACT_MIN_VERSION
          : BRIDGE_COMMAND_MIN_VERSION;
    if (conn.protocolVersion < minVersion) {
      const capability =
        cmd.action === 'extract'
          ? 'reading tab content'
          : isInteract
            ? 'driving the page'
            : 'tab management';
      return Promise.resolve({
        ok: false,
        error:
          `The connected YAAR Bridge extension is too old (protocol v${conn.protocolVersion}); ` +
          `${capability} needs v${minVersion}. Update the extension and reload it.`,
      });
    }

    const requestId = this.nextRequestId++;
    const frame: BridgeCommand = { type: 'command', requestId, ...cmd };
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: `Bridge command "${cmd.action}" timed out.` });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, error: `Failed to send command to the bridge: ${String(err)}` });
      }
    });
  }

  /** Called by the WS `command-result` path — resolves the matching in-flight command. */
  resolveCommand(result: BridgeCommandResult): void {
    const pending = this.pending.get(result.requestId);
    if (!pending) return; // already timed out / unknown id — ignore
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    pending.resolve(
      result.ok
        ? { ok: true, data: result.data }
        : { ok: false, error: result.error ?? 'Command failed.' },
    );
  }

  /**
   * Push a "YAAR is touching your browser" cue to the extension, which paints a transient
   * cursor/tracking overlay on the target tab. Fire-and-forget; a no-op when disconnected.
   */
  sendActivity(activity: Omit<BridgeActivity, 'type'>): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify({ type: 'activity', ...activity }));
    } catch {
      // Cosmetic only — never let a failed cue break the actual command path.
    }
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
