/**
 * The session's monitors — the virtual desktops, and the authoritative list of them.
 *
 * There is deliberately no `activeMonitorId` here. A session has N connections; "the
 * monitor the user is looking at" is a property of a *connection*, and collapsing it to one
 * field per session made it last-writer-wins: two tabs on different monitors, and tab B's
 * subscribe silently retargeted tab A's monitor-less actions. Where the user is looking
 * lives where it belongs — in the connection, held by the BroadcastCenter — and nothing is
 * monitor-less any more, so nothing needs to ask.
 *
 * The list itself was client state, minted from a per-tab counter: two tabs each made a
 * monitor "1", collided on one server-side agent, and neither could see the other's. So the
 * server mints the ids and broadcasts the list.
 *
 * Every collaborator arrives as a callback rather than as an imported singleton. The
 * registry decides *what* removing a monitor means; it does not decide which broadcast
 * center or which agent pool the session happens to be using, which is what makes it
 * testable without standing up either.
 */

import { MAX_MONITORS, DEFAULT_MONITOR_ID, ServerEventType, type MonitorInfo } from '@yaar/shared';
import type { ServerEvent } from '@yaar/shared';
import type { Viewport } from './layout-context.js';
import type { ConnectionId } from './broadcast-center.js';
import type { SessionId } from './types.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('MonitorRegistry');

export interface MonitorRegistryDeps {
  sessionId: SessionId;
  /** Session-wide delivery. See `LiveSession.broadcast` — the only server→client gateway. */
  broadcast(event: ServerEvent): void;
  /** Delivery to the one connection that asked. */
  sendTo(connectionId: ConnectionId, event: ServerEvent): void;
  /** Point a connection at a monitor. Replaces whatever it was watching. */
  subscribeConnection(connectionId: ConnectionId, monitorId: string): void;
  /** The monitor a connection is watching, or undefined before it has said. */
  connectionMonitor(connectionId: ConnectionId): string | undefined;
  /** Detach every connection watching a monitor that no longer exists. */
  unsubscribeMonitor(monitorId: string): void;
  /** Record a connection's viewport for layout. */
  setViewport(monitorId: string, viewport: Viewport): void;
  /** Forget a removed monitor's viewport, so its id's successor does not inherit it. */
  clearLayout(monitorId: string): void;
  /** Tear down the monitor's agent. Absent before the pool is initialized. */
  removeMonitorAgent(monitorId: string): Promise<void> | void;
}

export class MonitorRegistry {
  private monitors: MonitorInfo[] = [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1' }];

  constructor(private readonly deps: MonitorRegistryDeps) {}

  /** The session's monitors. Authoritative — the client renders this, it does not mint it. */
  list(): MonitorInfo[] {
    return this.monitors.map((m) => ({ ...m }));
  }

  has(monitorId: string): boolean {
    return this.monitors.some((m) => m.id === monitorId);
  }

  /**
   * Mint a monitor, or null if the session is full.
   *
   * The id is the lowest non-negative integer not in use, so a session that has churned
   * monitors reuses the gaps rather than counting forever — and, unlike a per-tab counter,
   * two tabs asking at once get two different monitors.
   */
  private mint(): MonitorInfo | null {
    if (this.monitors.length >= MAX_MONITORS) return null;
    const taken = new Set(this.monitors.map((m) => m.id));
    let n = 0;
    while (taken.has(String(n))) n++;
    const monitor: MonitorInfo = { id: String(n), label: `Monitor ${n + 1}` };
    this.monitors.push(monitor);
    return monitor;
  }

  /** A tab asked for a new monitor. */
  add(connectionId: ConnectionId): void {
    const monitor = this.mint();
    if (!monitor) {
      this.deps.sendTo(connectionId, {
        type: ServerEventType.ERROR,
        error: `Monitor limit reached (${MAX_MONITORS}).`,
      });
      return;
    }
    // Everyone gets the new list; only the tab that asked is told to go there.
    this.deps.broadcast({ type: ServerEventType.MONITORS, monitors: this.list() });
    this.deps.sendTo(connectionId, {
      type: ServerEventType.MONITORS,
      monitors: this.list(),
      focus: monitor.id,
    });
  }

  /**
   * The monitor a tab is looking at, or undefined before it has subscribed.
   *
   * A tab looks at one monitor at a time, so this is what attributes the frames that
   * carry no monitor of their own — a dismissed toast happened on the desktop the
   * sender was watching.
   */
  watchedBy(connectionId: ConnectionId): string | undefined {
    return this.deps.connectionMonitor(connectionId);
  }

  /** A tab reporting which monitor it is now looking at, and how big its viewport is. */
  subscribe(connectionId: ConnectionId, monitorId: string, viewport?: Viewport): void {
    this.deps.subscribeConnection(connectionId, monitorId);
    if (viewport) this.deps.setViewport(monitorId, viewport);
  }

  /**
   * Delete a monitor: its agent, its subscribers, its layout, and its place in the list.
   *
   * Removing the agent used to be the whole of it — the connections watching the monitor
   * stayed subscribed, so a deleted desktop kept delivering events and the frontend
   * dutifully re-created its windows. Detaching the subscribers is what makes the deletion
   * mean anything.
   *
   * This is the *only* definition of deleting a monitor, and the verb door
   * (`delete('yaar://session/monitors/{id}')`) goes through it for that reason: it used to
   * remove the agent alone, so the id stayed in this list, the frontend kept rendering the
   * desktop, and the next message on it lazily minted a fresh agent — a deletion that
   * silently undid itself.
   *
   * The returned promise settles when the agent is gone. Callers that only fire the
   * deletion may ignore it; the agent-removal failure is logged either way, so an ignored
   * return is never an unhandled rejection.
   */
  async remove(monitorId: string): Promise<void> {
    if (monitorId === DEFAULT_MONITOR_ID) return; // the session always has monitor 0
    if (!this.has(monitorId)) return;

    this.monitors = this.monitors.filter((m) => m.id !== monitorId);
    this.deps.unsubscribeMonitor(monitorId);
    // The ids are the lowest free integers, so this one comes back — and inherited the
    // dead monitor's viewport, which is what sizes the windows created on it.
    this.deps.clearLayout(monitorId);

    // Broadcast before awaiting the agent: the list is already true, and the frontend
    // should stop rendering the desktop without waiting on a provider teardown.
    this.deps.broadcast({ type: ServerEventType.MONITORS, monitors: this.list() });

    try {
      await this.deps.removeMonitorAgent(monitorId);
    } catch (err) {
      log.error('failed to remove monitor agent', {
        sessionId: this.deps.sessionId,
        monitorId,
        err,
      });
    }
  }
}
