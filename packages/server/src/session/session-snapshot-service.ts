/**
 * Everything a session currently holds, rendered as the actions that would recreate it —
 * and, by omission, everything it does not hold.
 *
 * A snapshot is built on demand, when the client asks (`RESYNC`), rather than pushed at
 * attach. The client asks only after flushing what *it* was holding, so by the time this
 * runs the registries have heard about the window the user opened while the socket was
 * down. A snapshot taken any earlier would report that window as nonexistent and the
 * client, treating this as authoritative, would dutifully delete it.
 *
 * This service is strictly read-only over the registries it is given. It does not acquire
 * providers, create agents, or mutate window state — a resync is a question, and a question
 * that changes the thing it asks about cannot be asked twice with the same answer.
 */

import type { ActiveAgentSnapshot, OSAction } from '@yaar/shared';
import type { SessionId } from './types.js';
import type { SurfaceRegistry } from './surface-state.js';
import type { WindowStateRegistry } from './window-state.js';
import { refreshIframeTokens } from '../logging/window-restore.js';

/** The subset of a pooled agent this snapshot reports. Narrowed so the pool stays out. */
export interface SnapshotAgent {
  id: string;
  label: string;
  busy: boolean;
  monitorId?: string;
}

export interface SessionSnapshotDeps {
  sessionId: SessionId;
  windowState: WindowStateRegistry;
  surfaces: SurfaceRegistry;
  /** The session's agents, or none before the pool exists. */
  listAgents(): SnapshotAgent[];
}

export class SessionSnapshotService {
  constructor(private readonly deps: SessionSnapshotDeps) {}

  /**
   * The session's windows as `window.create` actions, with fresh iframe tokens.
   *
   * The tokens are reminted rather than reused: the ones baked into the original action
   * are as old as the window, and a reconnecting client that renders a stale token gets an
   * iframe that cannot call a single verb.
   */
  async windowActions(): Promise<OSAction[]> {
    const windows = this.deps.windowState.listWindows();
    const actions: OSAction[] = windows.map((win) => ({
      type: 'window.create' as const,
      windowId: win.id,
      title: win.title,
      bounds: { ...win.bounds },
      content: { ...win.content },
      ...(win.variant ? { variant: win.variant } : {}),
      ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
      ...(win.frameless ? { frameless: win.frameless } : {}),
      ...(win.windowStyle ? { windowStyle: win.windowStyle } : {}),
      ...(win.minimized ? { minimized: win.minimized } : {}),
      ...(win.appId ? { appId: win.appId } : {}),
    }));
    return refreshIframeTokens(actions, this.deps.sessionId);
  }

  /** Windows, live surfaces, and the agents currently working. */
  async build(): Promise<{ actions: OSAction[]; agents: ActiveAgentSnapshot[] }> {
    const windows = await this.windowActions();
    const agents = this.deps
      .listAgents()
      .filter((a) => a.busy)
      .map((a) => ({
        agentId: a.id,
        status: a.label,
        ...(a.monitorId ? { monitorId: a.monitorId } : {}),
      }));
    return { actions: [...windows, ...this.deps.surfaces.snapshot()], agents };
  }
}
