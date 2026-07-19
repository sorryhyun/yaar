import type { ActionEvent } from '../../session/action-emitter.js';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';

export interface ToolActionBridgeState {
  currentRole: string | null;
  monitorId?: string;
  /** The live session this agent belongs to. Actions for any other one are not ours. */
  sessionId: string;
}

/**
 * Rewrite windowId fields in an action to use the scoped handle.
 * The resolver maps (rawWindowId, monitorId) → handle.
 */
function stampWindowHandle(
  action: OSAction,
  monitorId: string | undefined,
  resolveHandle: (rawId: string, monitorId?: string) => string,
): OSAction {
  const raw = (action as { windowId?: string }).windowId;
  if (!raw || !monitorId) return action;
  const handle = resolveHandle(raw, monitorId);
  if (handle === raw) return action;
  return { ...action, windowId: handle } as OSAction;
}

export class ToolActionBridge {
  constructor(
    private readonly state: ToolActionBridgeState,
    private readonly sendEvent: (event: ServerEvent) => Promise<void>,
    private readonly getFilterAgentId: () => string,
    private readonly getLogger: () => SessionLogger | null,
    private readonly recordAction: (action: OSAction) => void,
    private readonly resolveWindowHandle: (rawId: string, monitorId?: string) => string = (id) =>
      id,
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

    const action = stampWindowHandle(
      {
        ...event.action,
        ...(event.requestId && { requestId: event.requestId }),
        agentId: uiAgentId,
      } as OSAction,
      monitorId,
      this.resolveWindowHandle,
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
