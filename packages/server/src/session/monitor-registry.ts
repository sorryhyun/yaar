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
import type { FormFactor, Orientation, ServerEvent } from '@yaar/shared';
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
  /**
   * Whether a connection is the server's companion desktop — never looked at by a person,
   * so its screen is not the one windows should be laid out for.
   */
  isCompanion(connectionId: ConnectionId): boolean;
  /** Record a connection's viewport for layout. */
  setViewport(monitorId: string, viewport: Viewport): void;
  /** Record a connection's shell layout — whether the monitor agent is designing for a phone. */
  setFormFactor(monitorId: string, formFactor: FormFactor): void;
  /** Record how a connection's device is held; undefined forgets an earlier report. */
  setOrientation(monitorId: string, orientation: Orientation | undefined): void;
  /** Forget a removed monitor's viewport, so its id's successor does not inherit it. */
  clearLayout(monitorId: string): void;
  /** Tear down the monitor's agent. Absent before the pool is initialized. */
  removeMonitorAgent(monitorId: string): Promise<void> | void;
  /**
   * The cap on monitors, asked each time one is minted. `MAX_MONITORS` unless the host
   * says it cannot afford that many (`features/android/child-process-limit.ts`). A lower
   * cap never removes monitors that already exist; it only stops new ones.
   */
  maxMonitors?(): number;
}

export class MonitorRegistry {
  private monitors: MonitorInfo[] = [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1' }];

  constructor(private readonly deps: MonitorRegistryDeps) {}

  /** The session's monitors. Authoritative — the client renders this, it does not mint it. */
  list(): MonitorInfo[] {
    return this.monitors.map((m) => ({ ...m }));
  }

  /** The cap on this session's monitors right now. */
  maxMonitors(): number {
    return this.deps.maxMonitors?.() ?? MAX_MONITORS;
  }

  /** The list as the MONITORS event carries it, with the cap the client should honor. */
  event(focus?: string): ServerEvent {
    return {
      type: ServerEventType.MONITORS,
      monitors: this.list(),
      maxMonitors: this.maxMonitors(),
      ...(focus !== undefined ? { focus } : {}),
    };
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
    if (this.monitors.length >= this.maxMonitors()) return null;
    const taken = new Set(this.monitors.map((m) => m.id));
    let n = 0;
    while (taken.has(String(n))) n++;
    const monitor: MonitorInfo = { id: String(n), label: `Monitor ${n + 1}` };
    this.monitors.push(monitor);
    return monitor;
  }

  /** The cap, and why it is lower than usual when it is. */
  private limitReason(): string {
    const max = this.maxMonitors();
    return max < MAX_MONITORS
      ? `${max} while Android's child process restrictions are on — see Configurations → Updates`
      : String(max);
  }

  /** A tab asked for a new monitor. */
  add(connectionId: ConnectionId): void {
    const monitor = this.mint();
    if (!monitor) {
      this.deps.sendTo(connectionId, {
        type: ServerEventType.ERROR,
        error: `Monitor limit reached (${this.limitReason()}).`,
      });
      // The cap may have dropped since this tab last heard it — tell it the current one.
      this.deps.sendTo(connectionId, this.event());
      return;
    }
    // Everyone gets the new list; only the tab that asked is told to go there.
    this.deps.broadcast(this.event());
    this.deps.sendTo(connectionId, this.event(monitor.id));
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

  /**
   * A tab reporting which monitor it is now looking at, how big its viewport is, which
   * shell layout it renders, and which way it is held. A report with a viewport but no
   * form factor is from a desktop tab, so it clears a phone's earlier claim on the monitor
   * — orientation included, which travels with the form factor for the same reason.
   *
   * The layout is one per monitor, so whoever reports last owns it — and the companion
   * desktop reports too, forced to `?ui=desktop`, on the same monitor as the phone it
   * stands in for. Letting it write stamped the phone's monitor desktop-sized, and every
   * window after that opened at 640×480 on a 360-wide screen. The companion still watches
   * the monitor; it just has no say in what the user's screen is.
   */
  subscribe(
    connectionId: ConnectionId,
    monitorId: string,
    viewport?: Viewport,
    formFactor?: FormFactor,
    orientation?: Orientation,
  ): void {
    this.deps.subscribeConnection(connectionId, monitorId);
    if (this.deps.isCompanion(connectionId)) return;
    if (viewport) this.deps.setViewport(monitorId, viewport);
    if (viewport || formFactor) {
      this.deps.setFormFactor(monitorId, formFactor ?? 'desktop');
      this.deps.setOrientation(monitorId, orientation);
    }
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
    this.deps.broadcast(this.event());

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
