import type { ActionEvent } from '../../mcp/action-emitter.js';
import type { OSAction, DialogConfirmAction, ServerEvent } from '@yaar/shared';
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

    // Route permission dialogs through APPROVAL_REQUEST instead of ACTIONS
    if (action.type === 'dialog.confirm' && (action as DialogConfirmAction).permissionOptions) {
      const dialog = action as DialogConfirmAction;
      await this.sendEvent({
        type: 'APPROVAL_REQUEST',
        dialogId: dialog.id,
        title: dialog.title,
        message: dialog.message,
        confirmText: dialog.confirmText,
        cancelText: dialog.cancelText,
        permissionOptions: dialog.permissionOptions,
        agentId: uiAgentId,
      });
      await this.getLogger()?.logAction(action, uiAgentId);
      return;
    }

    await this.sendEvent({
      type: 'ACTIONS',
      actions: [action],
      agentId: uiAgentId,
      monitorId,
    });
    await this.getLogger()?.logAction(action, uiAgentId);
  }
}
