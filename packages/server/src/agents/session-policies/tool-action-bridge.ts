import type { ActionEvent } from '../../mcp/action-emitter.js';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';

export interface ToolActionBridgeState {
  currentRole: string | null;
  monitorId?: string;
}

export class ToolActionBridge {
  constructor(
    private readonly state: ToolActionBridgeState,
    private readonly sendEvent: (event: ServerEvent) => Promise<void>,
    private readonly getFilterAgentId: () => string,
    private readonly getLogger: () => SessionLogger | null,
    private readonly recordAction: (action: OSAction) => void,
  ) {}

  async handleToolAction(event: ActionEvent): Promise<void> {
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
    const action = {
      ...event.action,
      ...(event.requestId && { requestId: event.requestId }),
      agentId: uiAgentId,
    };

    // Prefer the event's monitorId (from action emitter) over the bridge's state
    const monitorId = event.monitorId ?? this.state.monitorId;

    await this.sendEvent({
      type: ServerEventType.ACTIONS,
      actions: [action],
      agentId: uiAgentId,
      monitorId,
    });
    await this.getLogger()?.logAction(action, uiAgentId);
  }
}
