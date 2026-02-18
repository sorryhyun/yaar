import type { StreamMessage } from '../../providers/types.js';
import { ServerEventType, type ServerEvent } from '@yaar/shared';
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
  private lastThinkingEmitTime = 0;
  private lastFlushedThinkingLength = 0;
  private thinkingDirty = false;

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
    private readonly onOutput?: (bytes: number) => void,
  ) {}

  async map(message: StreamMessage): Promise<void> {
    // Flush pending thinking before processing non-thinking messages
    if (message.type !== 'thinking') {
      await this.flushThinking();
    }

    switch (message.type) {
      case 'text':
        if (message.sessionId && this.onSessionId) {
          await this.onSessionId(message.sessionId);
        }
        if (message.content) {
          this.onOutput?.(message.content.length);
          this.state.responseText += message.content;
          await this.sendEvent({
            type: ServerEventType.AGENT_RESPONSE,
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
          this.thinkingDirty = true;

          // Throttle: emit AGENT_THINKING at most once per 200ms
          const now = Date.now();
          if (now - this.lastThinkingEmitTime >= 200) {
            this.lastThinkingEmitTime = now;
            await this.sendEvent({
              type: ServerEventType.AGENT_THINKING,
              content: this.state.thinkingText,
              agentId: this.role,
              monitorId: this.monitorId,
            });
          }
          // Logging deferred to flushThinking() — one entry per thinking block
        }
        break;

      case 'tool_use': {
        const displayName = formatToolDisplay(message.toolName ?? 'unknown');
        await this.sendEvent({
          type: ServerEventType.TOOL_PROGRESS,
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
          type: ServerEventType.TOOL_PROGRESS,
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
          type: ServerEventType.AGENT_RESPONSE,
          content: this.state.responseText,
          isComplete: true,
          agentId: this.role,
          monitorId: this.monitorId,
          messageId: this.state.currentMessageId ?? undefined,
        });
        break;

      case 'error':
        await this.sendEvent({
          type: ServerEventType.ERROR,
          error: message.error ?? 'Unknown error',
          agentId: this.role,
          monitorId: this.monitorId,
        });
        break;

      default:
        await this.sendEvent({
          type: ServerEventType.ERROR,
          error: `Unhandled stream message for provider ${this.providerName}`,
          agentId: this.role,
          monitorId: this.monitorId,
        });
    }
  }

  /**
   * Flush accumulated thinking: emit final event + log once per thinking block.
   * Called automatically when transitioning from thinking to any other message type.
   */
  private async flushThinking(): Promise<void> {
    if (!this.thinkingDirty) return;

    // Emit final thinking event with full accumulated text
    await this.sendEvent({
      type: ServerEventType.AGENT_THINKING,
      content: this.state.thinkingText,
      agentId: this.role,
      monitorId: this.monitorId,
    });

    // Log only the new thinking text since last flush (handles multiple thinking blocks)
    const newText = this.state.thinkingText.slice(this.lastFlushedThinkingLength);
    if (newText) {
      await this.logger?.logThinking(newText, this.role);
    }

    this.lastFlushedThinkingLength = this.state.thinkingText.length;
    this.thinkingDirty = false;
    this.lastThinkingEmitTime = 0;
  }
}
