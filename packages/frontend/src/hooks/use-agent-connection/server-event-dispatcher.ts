import type { ServerEvent, OSAction, AppProtocolRequestEvent, AppProtocolRequest } from '@/types';
import { ServerEventType, SUBAGENT_TOOL_NAME } from '@/types';

export interface ServerEventDispatchHandlers {
  applyActions: (actions: OSAction[]) => void;
  setIsConnecting: (value: boolean) => void;
  setConnectionStatus: (
    status: 'connecting' | 'connected' | 'disconnected' | 'error',
    error?: string,
  ) => void;
  setSession: (provider: string, sessionId: string) => void;
  checkForPreviousSession: (sessionId: string) => void;
  addDebugEntry: (entry: { direction: 'in'; type: string; data: ServerEvent }) => void;
  setAgentActive: (agentId: string, status: string) => void;
  clearAgent: (agentId: string) => void;
  registerWindowAgent: (
    windowId: string,
    agentId: string,
    status: 'assigned' | 'active' | 'released',
  ) => void;
  updateWindowAgentStatus: (agentId: string, status: 'assigned' | 'active' | 'released') => void;
  updateCliStreaming: (
    agentId: string,
    content: string,
    type: 'thinking' | 'response',
    monitorId?: string,
  ) => void;
  finalizeCliStreaming: (agentId: string) => void;
  addCliEntry: (entry: {
    type: 'user' | 'thinking' | 'response' | 'tool' | 'error' | 'action-summary';
    content: string;
    agentId?: string;
    monitorId?: string;
  }) => void;
  handleAppProtocolRequest: (
    requestId: string,
    windowId: string,
    request: AppProtocolRequest,
  ) => void;
  handleVerbSubscriptionUpdate: (windowId: string, subscriptionId: string, uri: string) => void;
  restoreCliHistory: (
    entries: {
      type: 'user' | 'thinking' | 'response' | 'tool' | 'error' | 'action-summary';
      content: string;
      agentId?: string;
      monitorId: string;
      timestamp: number;
    }[],
  ) => void;
  acceptMessage: (messageId: string, agentId: string) => void;
  queueMessage: (messageId: string, position: number) => void;
  clearAllMessageStatuses: () => void;
  incrementSubagentCount: (agentId: string) => void;
  decrementSubagentCount: (agentId: string) => void;
}

function extractAgentId(message: ServerEvent): string {
  return (message as { agentId?: string }).agentId || 'default';
}

export function dispatchServerEvent(message: ServerEvent, handlers: ServerEventDispatchHandlers) {
  const shouldLog =
    message.type === ServerEventType.ACTIONS ||
    message.type === ServerEventType.CONNECTION_STATUS ||
    message.type === ServerEventType.ERROR ||
    (message.type === ServerEventType.AGENT_RESPONSE &&
      (message as { isComplete?: boolean }).isComplete) ||
    (message.type === ServerEventType.TOOL_PROGRESS &&
      (message as { status?: string }).status !== 'running');

  if (shouldLog) {
    handlers.addDebugEntry({
      direction: 'in',
      type: message.type,
      data: message,
    });
  }

  switch (message.type) {
    case ServerEventType.ACTIONS: {
      const monitorId = (message as { monitorId?: string }).monitorId;
      // Server already stamps scoped handles on windowId — just pass actions through.
      // monitorId is only used for CLI entry attribution below.
      handlers.applyActions(message.actions);
      // Summarize actions for CLI
      const summary = message.actions
        .map((a) => {
          if (a.type === 'window.create')
            return `Created window: ${(a as { title?: string }).title ?? a.windowId}`;
          if (a.type === 'window.close') return `Closed window: ${a.windowId}`;
          if (a.type === 'window.setContent') return `Updated content: ${a.windowId}`;
          return a.type;
        })
        .join('; ');
      handlers.addCliEntry({ type: 'action-summary', content: summary, monitorId });
      break;
    }
    case ServerEventType.CONNECTION_STATUS:
      handlers.setIsConnecting(false);
      handlers.setConnectionStatus(
        message.status === 'connected'
          ? 'connected'
          : message.status === 'error'
            ? 'error'
            : 'disconnected',
        message.error,
      );
      if (message.provider && message.sessionId) {
        handlers.setSession(message.provider, message.sessionId);
        handlers.checkForPreviousSession(message.sessionId);
      }
      break;
    case ServerEventType.AGENT_THINKING: {
      const agentId = extractAgentId(message);
      const monitorId = (message as { monitorId?: string }).monitorId;
      handlers.setAgentActive(agentId, message.content ? 'Reasoning...' : 'Thinking...');
      handlers.updateCliStreaming(agentId, message.content ?? '', 'thinking', monitorId);
      handlers.clearAllMessageStatuses();
      break;
    }
    case ServerEventType.AGENT_RESPONSE: {
      const agentId = extractAgentId(message);
      const isComplete = (message as { isComplete?: boolean }).isComplete;
      const monitorId = (message as { monitorId?: string }).monitorId;
      if (isComplete) {
        handlers.clearAgent(agentId);
        handlers.finalizeCliStreaming(agentId);
      } else {
        handlers.setAgentActive(agentId, 'Responding...');
        handlers.updateCliStreaming(agentId, message.content, 'response', monitorId);
      }
      break;
    }
    case ServerEventType.TOOL_PROGRESS: {
      const agentId = extractAgentId(message);
      const toolName = (message as { toolName?: string }).toolName || 'tool';
      const status = (message as { status?: string }).status;
      const toolInput = (message as { toolInput?: unknown }).toolInput;
      const monitorId = (message as { monitorId?: string }).monitorId;
      // Track subagent lifecycle (exact match for start/end, startsWith for progress)
      const isSubagent =
        toolName === SUBAGENT_TOOL_NAME || toolName.startsWith(`${SUBAGENT_TOOL_NAME}:`);
      // Detect Agent/Task tool_use (the raw invocation from Claude with full prompt)
      const isAgentTool = toolName === 'Agent' || toolName === 'Task';
      if (status === 'running') {
        let statusText = `Running: ${toolName}`;
        if ((isSubagent || isAgentTool) && toolInput) {
          const input = toolInput as Record<string, unknown>;
          const agentType = (input.subagent_type ?? '') as string;
          const desc = (input.description ?? input.prompt ?? '') as string;
          const shortDesc = desc ? (desc.length > 60 ? desc.slice(0, 60) + '...' : desc) : '';
          if (isAgentTool && agentType) {
            statusText = `Subagent (${agentType})${shortDesc ? ': ' + shortDesc : ''}`;
          } else if (toolName.startsWith(`${SUBAGENT_TOOL_NAME}:`)) {
            const innerTool = toolName.replace(`${SUBAGENT_TOOL_NAME}:`, '');
            // Prefer URI over description for status text
            const uri = (input.uri ?? '') as string;
            const detail = uri || shortDesc;
            statusText = `Subagent → ${innerTool}${detail ? ': ' + detail : ''}`;
          } else if (shortDesc) {
            statusText = `Subagent: ${shortDesc}`;
          }
        }
        handlers.setAgentActive(agentId, statusText);
      } else if (status === 'error') {
        const errorMsg = (message as { message?: string }).message;
        handlers.setAgentActive(
          agentId,
          `Error: ${toolName}${errorMsg ? ' — ' + errorMsg.slice(0, 80) : ''}`,
        );
      } else if (status === 'complete') {
        handlers.setAgentActive(agentId, 'Thinking...');
      }
      if (isSubagent && status === 'running' && toolName === SUBAGENT_TOOL_NAME) {
        handlers.incrementSubagentCount(agentId);
      } else if (isSubagent && status === 'complete' && toolName === SUBAGENT_TOOL_NAME) {
        handlers.decrementSubagentCount(agentId);
      }
      // Skip successful results (except subagent completions which carry a summary)
      if (status === 'complete') {
        if (isSubagent) {
          const summary = (message as { message?: string }).message;
          if (summary) {
            handlers.addCliEntry({
              type: 'tool',
              content: `[${toolName}] ${summary}`,
              agentId,
              monitorId,
            });
          }
        }
        break;
      }
      let content: string;
      if (status === 'running' && toolInput) {
        let inputStr: string;
        if (isAgentTool) {
          // Agent tool_use: show subagent type + prompt from monitor agent
          const input = toolInput as Record<string, unknown>;
          const agentType = (input.subagent_type ?? '') as string;
          const prompt = (input.prompt ?? input.description ?? '') as string;
          inputStr = agentType ? `(${agentType}) ${prompt}` : prompt;
          if (!inputStr) inputStr = JSON.stringify(toolInput);
        } else if (isSubagent) {
          // Subagent tool progress: prefer URI (enriched by server) over description
          const input = toolInput as Record<string, unknown>;
          if (input.uri) {
            // Rich info from MCP buffer: show verb:(uri) format
            const payload = input.payload as Record<string, unknown> | undefined;
            const action = payload?.action;
            inputStr = action ? `${input.uri} (${action})` : (input.uri as string);
          } else {
            inputStr = (input.description ?? input.prompt ?? '') as string;
          }
          if (!inputStr) inputStr = JSON.stringify(toolInput);
        } else {
          inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
        }
        // Use → separator for subagent progress tools (e.g., "subagent → read")
        const displayName = isSubagent
          ? toolName.replace(':', ' → ')
          : isAgentTool
            ? 'subagent'
            : toolName;
        content = `[${displayName}] ${inputStr}`;
      } else {
        const displayName = isSubagent
          ? toolName.replace(':', ' → ')
          : isAgentTool
            ? 'subagent'
            : toolName;
        content = `[${displayName}] ${status}`;
      }
      handlers.addCliEntry({
        type: status === 'error' ? 'error' : 'tool',
        content,
        agentId,
        monitorId,
      });
      break;
    }
    case ServerEventType.ERROR: {
      const monitorId = (message as { monitorId?: string }).monitorId;
      handlers.setConnectionStatus('error', message.error);
      handlers.addCliEntry({ type: 'error', content: message.error, monitorId });
      break;
    }
    case ServerEventType.WINDOW_AGENT_STATUS: {
      const { windowId, agentId, status } = message;
      if (status === 'assigned') {
        handlers.registerWindowAgent(windowId, agentId, status);
      } else {
        handlers.updateWindowAgentStatus(agentId, status);
      }
      break;
    }
    case ServerEventType.APPROVAL_REQUEST: {
      // Convert to a dialog.confirm action and route through the existing dialog system.
      // This keeps the existing ConfirmDialog UI working; can be upgraded to inline later.
      handlers.applyActions([
        {
          type: 'dialog.confirm' as const,
          id: message.dialogId,
          title: message.title,
          message: message.message,
          confirmText: message.confirmText,
          cancelText: message.cancelText,
          permissionOptions: message.permissionOptions,
        },
      ]);
      break;
    }
    case ServerEventType.APP_PROTOCOL_REQUEST: {
      const m = message as AppProtocolRequestEvent;
      handlers.handleAppProtocolRequest(m.requestId, m.windowId, m.request);
      break;
    }
    case ServerEventType.VERB_SUBSCRIPTION_UPDATE: {
      const m = message as { windowId: string; subscriptionId: string; uri: string };
      handlers.handleVerbSubscriptionUpdate(m.windowId, m.subscriptionId, m.uri);
      break;
    }
    case ServerEventType.CLI_RESTORE: {
      const { entries } = message as { entries: Parameters<typeof handlers.restoreCliHistory>[0] };
      handlers.restoreCliHistory(entries);
      break;
    }
    case ServerEventType.MESSAGE_ACCEPTED:
      handlers.acceptMessage(message.messageId, message.agentId);
      break;
    case ServerEventType.MESSAGE_QUEUED:
      handlers.queueMessage(message.messageId, message.position);
      break;
  }
}
