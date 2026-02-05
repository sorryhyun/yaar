import type { ActionEvent } from '../../mcp/action-emitter.js';
import type { OSAction, ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';

export interface ToolActionBridgeState {
  currentRole: string | null;
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

    this.recordAction(event.action);

    const uiAgentId = this.state.currentRole ?? 'default';
    const action = {
      ...event.action,
      ...(event.requestId && { requestId: event.requestId }),
      agentId: uiAgentId,
    };

    await this.sendEvent({
      type: 'ACTIONS',
      actions: [action],
      agentId: uiAgentId,
    });
    await this.getLogger()?.logAction(action, uiAgentId);
  }
}
