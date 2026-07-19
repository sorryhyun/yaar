import type {
  ServerEvent,
  OSAction,
  AppProtocolRequestEvent,
  AppProtocolRequest,
  RecoveryMode,
  ActiveAgentSnapshot,
  StreamFrame,
  StreamFrameEvent,
} from '@/types';
import { ServerEventType, SUBAGENT_TOOL_NAME } from '@/types';

export interface ServerEventDispatchHandlers {
  applyActions: (actions: OSAction[]) => void;
  setIsConnecting: (value: boolean) => void;
  setConnectionStatus: (
    status: 'connecting' | 'connected' | 'disconnected' | 'error',
    error?: string,
  ) => void;
  setSession: (provider: string, sessionId: string) => void;
  setAttachment: (attachment: {
    sessionId: string;
    sessionEpoch: number;
    connectionId: string;
    recoveryMode: RecoveryMode;
    provider?: string;
  }) => void;
  checkForPreviousSession: (sessionId: string) => void;
  /** Apply the session's authoritative monitor list; `focus` answers this tab's ADD_MONITOR. */
  setMonitors: (monitors: { id: string; label: string }[], focus?: string) => void;
  /** Re-mint iframe tokens after reattaching to a session incarnation we did not leave. */
  refreshStaleIframeTokens: (sessionId: string) => void;
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
    type: 'thinking' | 'response' | 'tool',
    monitorId?: string,
  ) => void;
  appendCliStreaming: (
    agentId: string,
    delta: string,
    type: 'thinking' | 'response' | 'tool',
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
    timeoutMs?: number,
  ) => void;
  handleVerbSubscriptionUpdate: (windowId: string, subscriptionId: string, uri: string) => void;
  handleStreamFrame: (windowId: string, subscriptionId: string, frame: StreamFrame) => void;
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
  failMessage: (messageId: string, error: string) => void;
  settleOutbox: (messageId: string) => void;
  clearAllMessageStatuses: () => void;
  applySnapshot: (actions: OSAction[], agents: ActiveAgentSnapshot[]) => void;
  /** Send everything buffered while the socket was down (interactions, outbox). */
  flushPending: () => void;
  /** Ask the server for authoritative state, once the flush is on the wire. */
  resync: () => void;
  incrementSubagentCount: (agentId: string) => void;
  decrementSubagentCount: (agentId: string) => void;
}

function extractAgentId(message: ServerEvent): string {
  return (message as { agentId?: string }).agentId || 'default';
}

export function dispatchServerEvent(message: ServerEvent, handlers: ServerEventDispatchHandlers) {
  const shouldLog =
    message.type === ServerEventType.ACTIONS ||
    message.type === ServerEventType.SESSION_ATTACHED ||
    message.type === ServerEventType.CONNECTION_STATUS ||
    message.type === ServerEventType.ERROR ||
    (message.type === ServerEventType.AGENT_RESPONSE &&
      (message as { isComplete?: boolean }).isComplete) ||
    // `pending` is one event per argument fragment — a firehose that would bury
    // the debug panel, and it carries no information the `running` event lacks.
    (message.type === ServerEventType.TOOL_PROGRESS &&
      (message as { status?: string }).status !== 'running' &&
      (message as { status?: string }).status !== 'pending');

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
    case ServerEventType.SESSION_ATTACHED: {
      // The join completed: this socket now carries a named session incarnation. Until
      // this arrives the transport is open but bound to nothing, so it is this event —
      // not the socket's open — that puts the UI into "connected".
      handlers.setIsConnecting(false);
      handlers.setAttachment({
        sessionId: message.sessionId,
        sessionEpoch: message.sessionEpoch,
        connectionId: message.connectionId,
        recoveryMode: message.recoveryMode,
        provider: message.provider,
      });
      if (message.recoveryMode !== 'attached' && message.recoveryMode !== 'created') {
        // Not the session we left. The iframe tokens our windows hold were minted by a
        // process that is gone, so every verb call they make now 403s. Mint them again
        // against the live session. (Everything *else* that is stale — closed windows still
        // on screen, spinners for finished agents — is fixed by the resync below, which
        // replaces local state with the server's rather than merging into it.)
        handlers.refreshStaleIframeTokens(message.sessionId);
      }
      // Say what we did while we were away, then ask what is actually there. The order is
      // the contract: the snapshot that comes back is authoritative and will delete
      // anything it does not mention, so the window the user opened during the outage has
      // to reach the server *before* the server is asked to describe itself.
      handlers.flushPending();
      handlers.resync();
      // sessionId is the hub key (WebSocket rejoin, iframe tokens); logSessionId names the
      // transcript on disk, which is what /api/sessions is keyed by.
      handlers.checkForPreviousSession(message.logSessionId ?? message.sessionId);
      break;
    }
    case ServerEventType.SNAPSHOT:
      // Authoritative. Replaces; does not merge. See `applySnapshot` in store/desktop.ts.
      handlers.applySnapshot(message.actions, message.agents);
      break;
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
        // sessionId is the hub key (WebSocket rejoin, iframe tokens); logSessionId names
        // the transcript on disk, which is what /api/sessions is keyed by.
        handlers.setSession(message.provider, message.sessionId);
        handlers.checkForPreviousSession(message.logSessionId ?? message.sessionId);
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

      // The parameter-generation phase: the model has named a tool but is still
      // writing its arguments. Render them raw as they arrive, so a large input
      // shows progress instead of a stall; the `running` branch below throws this
      // scaffolding away and replaces it with the summarized entry.
      if (status === 'pending') {
        const fragment = (message as { message?: string }).message;
        if (fragment === undefined) {
          // The announcement. Flush the preceding text/thinking block first, for
          // the same chronological reason as the `running` case.
          handlers.finalizeCliStreaming(agentId);
          handlers.setAgentActive(agentId, `Preparing: ${toolName}`);
          handlers.updateCliStreaming(agentId, `[${toolName}] `, 'tool', monitorId);
        } else {
          handlers.appendCliStreaming(agentId, fragment, 'tool', monitorId);
        }
        break;
      }

      // A tool call ends the current text/thinking block. Flush it into `cliHistory`
      // *before* appending the tool entry so the two land in true chronological order —
      // otherwise the live text sits in `cliStreaming`, which TerminalPane renders after
      // all of history, and every tool appears to precede everything the agent said.
      if (status === 'running') {
        handlers.finalizeCliStreaming(agentId);
      }
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
      // An error that names a message is that message's obituary: it will not run. Mark it
      // failed and stop holding it for redelivery — resending a message the server has
      // already refused just gets it refused again.
      if (message.messageId) {
        handlers.failMessage(message.messageId, message.error);
        handlers.settleOutbox(message.messageId);
      }
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
      handlers.handleAppProtocolRequest(m.requestId, m.windowId, m.request, m.timeoutMs);
      break;
    }
    case ServerEventType.VERB_SUBSCRIPTION_UPDATE: {
      const m = message as { windowId: string; subscriptionId: string; uri: string };
      handlers.handleVerbSubscriptionUpdate(m.windowId, m.subscriptionId, m.uri);
      break;
    }
    case ServerEventType.STREAM_FRAME: {
      const m = message as StreamFrameEvent;
      handlers.handleStreamFrame(m.windowId, m.subscriptionId, m.frame);
      break;
    }
    case ServerEventType.CLI_RESTORE: {
      const { entries } = message as { entries: Parameters<typeof handlers.restoreCliHistory>[0] };
      handlers.restoreCliHistory(entries);
      break;
    }
    case ServerEventType.MONITORS: {
      const m = message as { monitors: { id: string; label: string }[]; focus?: string };
      handlers.setMonitors(m.monitors, m.focus);
      break;
    }
    // The two acks. Either one means the server has taken responsibility for the message,
    // so the outbox can let go of it — that, and nothing about the socket's state, is what
    // "delivered" means.
    case ServerEventType.MESSAGE_ACCEPTED:
      handlers.acceptMessage(message.messageId, message.agentId);
      handlers.settleOutbox(message.messageId);
      break;
    case ServerEventType.MESSAGE_QUEUED:
      handlers.queueMessage(message.messageId, message.position);
      handlers.settleOutbox(message.messageId);
      break;
  }
}
