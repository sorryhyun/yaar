import type { StreamMessage } from '../../providers/types.js';
import type { ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';
import type { ContextSource } from '../context.js';
import { formatToolDisplay } from '../../mcp/register.js';
import { actionEmitter } from '../../mcp/action-emitter.js';
import { getToolUseHooks } from '../../mcp/system/hooks.js';

export interface StreamMappingState {
  responseText: string;
  thinkingText: string;
  currentMessageId: string | null;
}

export class StreamToEventMapper {
  constructor(
    private readonly role: string,
    private readonly providerName: string,
    private readonly state: StreamMappingState,
    private readonly sendEvent: (event: ServerEvent) => Promise<void>,
    private readonly logger: SessionLogger | null,
    private readonly source: ContextSource,
    private readonly onContextMessage?: (role: 'user' | 'assistant', content: string) => void,
    private readonly onSessionId?: (sessionId: string) => Promise<void>,
    private readonly monitorId?: string,
  ) {}

  async map(message: StreamMessage): Promise<void> {
    switch (message.type) {
      case 'text':
        if (message.sessionId && this.onSessionId) {
          await this.onSessionId(message.sessionId);
        }
        if (message.content) {
          this.state.responseText += message.content;
          await this.sendEvent({
            type: 'AGENT_RESPONSE',
            content: this.state.responseText,
            isComplete: false,
            agentId: this.role,
            monitorId: this.monitorId,
            messageId: this.state.currentMessageId ?? undefined,
          });
        }
        break;

      case 'thinking':
        if (message.content) {
          this.state.thinkingText += message.content;
          await this.sendEvent({
            type: 'AGENT_THINKING',
            content: this.state.thinkingText,
            agentId: this.role,
            monitorId: this.monitorId,
          });
          await this.logger?.logThinking(message.content, this.role);
        }
        break;

      case 'tool_use': {
        const displayName = formatToolDisplay(message.toolName ?? 'unknown');
        await this.sendEvent({
          type: 'TOOL_PROGRESS',
          toolName: displayName,
          status: 'running',
          toolInput: message.toolInput,
          agentId: this.role,
          monitorId: this.monitorId,
        });
        await this.logger?.logToolUse(
          message.toolName ?? 'unknown',
          message.toolInput,
          message.toolUseId,
          this.role,
        );

        // Execute matching tool_use hooks
        const hooks = await getToolUseHooks(displayName);
        for (const hook of hooks) {
          if (hook.action.type === 'os_action') {
            const actions = Array.isArray(hook.action.payload)
              ? hook.action.payload
              : [hook.action.payload];
            for (const action of actions) {
              actionEmitter.emitAction(action);
            }
          }
        }
        break;
      }

      case 'tool_result':
        await this.sendEvent({
          type: 'TOOL_PROGRESS',
          toolName: formatToolDisplay(message.toolName ?? 'tool'),
          status: 'complete',
          message: message.content,
          agentId: this.role,
          monitorId: this.monitorId,
        });
        await this.logger?.logToolResult(
          message.toolName ?? 'tool',
          message.content,
          message.toolUseId,
          this.role,
        );
        break;

      case 'complete':
        if (message.sessionId && this.onSessionId) {
          await this.onSessionId(message.sessionId);
        }
        if (this.state.responseText) {
          await this.logger?.logAssistantMessage(this.state.responseText, this.role, this.source);
          await this.logger?.updateLastActivity();
          this.onContextMessage?.('assistant', this.state.responseText);
        }
        await this.sendEvent({
          type: 'AGENT_RESPONSE',
          content: this.state.responseText,
          isComplete: true,
          agentId: this.role,
          monitorId: this.monitorId,
          messageId: this.state.currentMessageId ?? undefined,
        });
        break;

      case 'error':
        await this.sendEvent({
          type: 'ERROR',
          error: message.error ?? 'Unknown error',
          agentId: this.role,
          monitorId: this.monitorId,
        });
        break;

      default:
        await this.sendEvent({
          type: 'ERROR',
          error: `Unhandled stream message for provider ${this.providerName}`,
          agentId: this.role,
          monitorId: this.monitorId,
        });
    }
  }
}
