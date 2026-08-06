import type { ActionEvent } from '../../session/action-emitter.js';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';
import {
  stampWindowHandle,
  windowHandleFor,
  type WindowHandleResolver,
} from '../../session/window-handle-stamp.js';

export interface ToolActionBridgeState {
  currentRole: string | null;
  monitorId?: string;
  /** The live session this agent belongs to. Actions for any other one are not ours. */
  sessionId: string;
}

export class ToolActionBridge {
  constructor(
    private readonly state: ToolActionBridgeState,
    private readonly sendEvent: (event: ServerEvent) => Promise<void>,
    private readonly getFilterAgentId: () => string,
    private readonly getLogger: () => SessionLogger | null,
    private readonly recordAction: (action: OSAction) => void,
    private readonly resolveWindowHandle: WindowHandleResolver = (id) => id,
  ) {}

  async handleToolAction(event: ActionEvent): Promise<void> {
    // Session first, because the agent filter below has a hole the session filter closes:
    // an action emitted outside any turn carries no `agentId`, and `event.agentId &&`
    // lets exactly those through — in *every* session, to every agent's socket. The
    // emitter now addresses every action, so the hole is closable rather than merely known.
    if (event.sessionId !== this.state.sessionId) {
      return;
    }

    const myAgentId = this.getFilterAgentId();
    if (event.agentId && event.agentId !== myAgentId) {
      return;
    }

    // Filter by monitorId: if both the event and this bridge have a monitorId, they must match
    if (event.monitorId && this.state.monitorId && event.monitorId !== this.state.monitorId) {
      return;
    }

    this.recordAction(event.action);

    const uiAgentId = this.state.currentRole ?? 'default';
    // Prefer the event's monitorId (from action emitter) over the bridge's state
    const monitorId = event.monitorId ?? this.state.monitorId;

    // The agent's turn has already applied the action to the window registry by the time
    // this runs (`LiveSession.handleEmittedAction` is the same emit), so there is no
    // "before" to ask and no `priorHandle` to pass — which is correct for a create and
    // best-effort for the rest. See `window-handle-stamp.ts`.
    const addressed = { ...event.action, agentId: uiAgentId } as OSAction;
    const action = stampWindowHandle(
      addressed,
      windowHandleFor(addressed, this.resolveWindowHandle, monitorId),
      event.requestId,
    );

    await this.sendEvent({
      type: ServerEventType.ACTIONS,
      actions: [action],
      agentId: uiAgentId,
      monitorId,
    });
    this.getLogger()?.logAction(action, uiAgentId);
  }
}
