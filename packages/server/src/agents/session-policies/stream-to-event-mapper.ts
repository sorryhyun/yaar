import type { StreamMessage } from '../../providers/types.js';
import { ServerEventType, type ServerEvent } from '@yaar/shared';
import type { SessionLogger } from '../../logging/index.js';
import type { ContextSource } from '../context.js';
import { formatToolDisplay } from '../../mcp/server.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getToolUseHooks, type ToolUseContext } from '../../features/config/hooks.js';
import { VERB_TOOL_NAMES } from '../../handlers/index.js';
import { publishFrame } from '../../streams/stream-hub.js';
import { buildAgentStreamUri, type AgentStreamKind } from '../../streams/agent-stream.js';

export interface StreamMappingState {
  responseText: string;
  thinkingText: string;
  currentMessageId: string | null;
}

/**
 * Tool-error classification table — **first match wins, so the order is load-bearing**.
 * The substring sets overlap (a "Validation Error" contains both `Validation` and
 * `Error`), so reordering rows silently reclassifies errors. Append new rows above
 * the catch-all `Error` row only if they must win over it.
 */
const ERROR_CATEGORY_RULES: readonly (readonly [
  substrings: readonly string[],
  category: string,
])[] = [
  [['URI not found', 'No handler'], 'uri_not_found'],
  [['not supported', 'Unknown verb'], 'verb_not_supported'],
  [['Validation', 'Invalid'], 'validation'],
  [['Error'], 'handler_error'],
];

/** Classify a tool error message into a coarse category for logging/metrics. */
function classifyToolError(content: string): string {
  for (const [substrings, category] of ERROR_CATEGORY_RULES) {
    if (substrings.some((s) => content.includes(s))) return category;
  }
  return 'unknown';
}

export interface StreamMapperOptions {
  role: string;
  providerName: string;
  state: StreamMappingState;
  sendEvent: (event: ServerEvent) => Promise<void>;
  logger: SessionLogger | null;
  source: ContextSource;
  onContextMessage?: (role: 'user' | 'assistant', content: string) => void;
  onSessionId?: (sessionId: string) => Promise<void>;
  monitorId?: string;
  onOutput?: (bytes: number) => void;
  /** Agent instance id — keys this agent's `yaar://agents/{id}/stream` feed. */
  agentInstanceId?: string;
  /** Session the frames belong to — scopes them so session A can't read B. */
  streamSessionId?: string;
}

export class StreamToEventMapper {
  private lastThinkingEmitTime = 0;
  private lastFlushedThinkingLength = 0;
  private thinkingDirty = false;
  private toolStartTimes = new Map<string, { toolName: string; startTime: number }>();

  /**
   * Text emitted since the last tool call — the *current* block, not the turn.
   *
   * `state.responseText` stays cumulative because `complete` logs it and feeds it to
   * context as the turn's single assistant message. But AGENT_RESPONSE is a live feed:
   * if it carried the running accumulation, the CLI panel could not tell "the text
   * before tool 1" from "the text after tool 2" — they arrive as one ever-growing
   * string — and every text block would collapse into one entry rendered after all
   * the tools. Resetting at each `tool_use` makes each block addressable.
   */
  private blockText = '';
  /** Offset into `state.thinkingText` where the current block starts — same reason. */
  private blockThinkingStart = 0;

  private readonly role: string;
  private readonly providerName: string;
  private readonly state: StreamMappingState;
  private readonly sendEvent: (event: ServerEvent) => Promise<void>;
  private readonly logger: SessionLogger | null;
  private readonly source: ContextSource;
  private readonly onContextMessage?: (role: 'user' | 'assistant', content: string) => void;
  private readonly onSessionId?: (sessionId: string) => Promise<void>;
  private readonly monitorId?: string;
  private readonly onOutput?: (bytes: number) => void;
  private readonly agentInstanceId?: string;
  private readonly streamSessionId?: string;

  constructor(options: StreamMapperOptions) {
    this.role = options.role;
    this.providerName = options.providerName;
    this.state = options.state;
    this.sendEvent = options.sendEvent;
    this.logger = options.logger;
    this.source = options.source;
    this.onContextMessage = options.onContextMessage;
    this.onSessionId = options.onSessionId;
    this.monitorId = options.monitorId;
    this.onOutput = options.onOutput;
    this.agentInstanceId = options.agentInstanceId;
    this.streamSessionId = options.streamSessionId;
  }

  /**
   * Publish one frame onto this agent's `yaar://agents/{id}/stream` feed, for any
   * app (or agent) that subscribed. Additive: the `sendEvent` path above is the
   * frontend CLI panel and is untouched. A no-op when we lack the id/session to
   * name and scope the feed (e.g. an ephemeral agent).
   */
  private emitStreamFrame(kind: AgentStreamKind, data: unknown): void {
    if (!this.agentInstanceId || !this.streamSessionId) return;
    publishFrame(buildAgentStreamUri(this.agentInstanceId), kind, data, this.streamSessionId);
  }

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
          this.blockText += message.content;
          await this.sendEvent({
            type: ServerEventType.AGENT_RESPONSE,
            content: this.blockText,
            isComplete: false,
            agentId: this.role,
            monitorId: this.monitorId,
            messageId: this.state.currentMessageId ?? undefined,
          });
          // Stream subscribers get the *delta*, not the running accumulation —
          // the registry coalesces these on a tick.
          this.emitStreamFrame('text', { delta: message.content });
        }
        break;

      case 'thinking':
        if (message.content) {
          this.state.thinkingText += message.content;
          this.thinkingDirty = true;
          this.emitStreamFrame('thinking', { delta: message.content });

          // Throttle: emit AGENT_THINKING at most once per 200ms
          const now = Date.now();
          if (now - this.lastThinkingEmitTime >= 200) {
            this.lastThinkingEmitTime = now;
            await this.sendEvent({
              type: ServerEventType.AGENT_THINKING,
              content: this.state.thinkingText.slice(this.blockThinkingStart),
              agentId: this.role,
              monitorId: this.monitorId,
            });
          }
          // Logging deferred to flushThinking() — one entry per thinking block
        }
        break;

      case 'tool_use': {
        // Close the current text/thinking block: whatever the agent says next is a new
        // one, and the client renders it after this tool rather than merged with what
        // came before.
        this.blockText = '';
        this.blockThinkingStart = this.state.thinkingText.length;

        const rawName = message.toolName ?? 'unknown';
        let displayName = formatToolDisplay(rawName);
        let displayInput = message.toolInput;

        // For verb tools, embed URI in the display name and show only the payload
        if ((VERB_TOOL_NAMES as readonly string[]).includes(rawName)) {
          const input = message.toolInput as Record<string, unknown> | undefined;
          const verb = rawName.replace('mcp__verbs__', '');
          const uri = input?.uri;
          displayName = uri ? `${verb}:(${uri})` : verb;
          // Strip uri from display input, show only payload (or nothing)
          if (input) {
            const { uri: _uri, ...rest } = input;
            displayInput = Object.keys(rest).length > 0 ? rest : undefined;
          }
        }

        await this.sendEvent({
          type: ServerEventType.TOOL_PROGRESS,
          toolName: displayName,
          status: 'running',
          toolInput: displayInput,
          agentId: this.role,
          monitorId: this.monitorId,
        });
        this.emitStreamFrame('tool', {
          toolName: displayName,
          status: 'running',
          input: displayInput,
        });
        this.logger?.logToolUse(
          message.toolName ?? 'unknown',
          message.toolInput,
          message.toolUseId,
          this.role,
        );
        if (message.toolUseId) {
          this.toolStartTimes.set(message.toolUseId, {
            toolName: message.toolName ?? 'unknown',
            startTime: Date.now(),
          });
        }

        // Execute matching tool_use hooks
        const hookCtx: ToolUseContext = { toolName: displayName };

        // For verb tools, extract verb/uri/action from toolInput
        if ((VERB_TOOL_NAMES as readonly string[]).includes(rawName)) {
          const input = message.toolInput as Record<string, unknown> | undefined;
          hookCtx.verb = rawName.replace('mcp__verbs__', '');
          if (input?.uri && typeof input.uri === 'string') hookCtx.uri = input.uri;
          if (input?.payload && typeof input.payload === 'object' && input.payload !== null) {
            const action = (input.payload as Record<string, unknown>).action;
            if (typeof action === 'string') hookCtx.action = action;
          }
        }

        const hooks = await getToolUseHooks(hookCtx);
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

      case 'tool_result': {
        const isError = message.isError === true;
        const resultToolName = formatToolDisplay(message.toolName ?? 'tool');
        await this.sendEvent({
          type: ServerEventType.TOOL_PROGRESS,
          toolName: resultToolName,
          status: isError ? 'error' : 'complete',
          message: message.content,
          agentId: this.role,
          monitorId: this.monitorId,
        });
        this.emitStreamFrame('tool', {
          toolName: resultToolName,
          status: isError ? 'error' : 'complete',
        });
        if (isError) {
          console.warn(
            `[ToolError] ${formatToolDisplay(message.toolName ?? 'tool')}: ${message.content?.slice(0, 200)}`,
          );
        }
        // Compute timing + error metadata
        let meta: { isError?: boolean; errorCategory?: string; durationMs?: number } | undefined;
        if (message.toolUseId) {
          const startEntry = this.toolStartTimes.get(message.toolUseId);
          if (startEntry) {
            const durationMs = Date.now() - startEntry.startTime;
            this.toolStartTimes.delete(message.toolUseId);
            const errorCategory =
              isError && message.content ? classifyToolError(message.content) : undefined;
            meta = { durationMs, ...(isError ? { isError, errorCategory } : {}) };
          }
        }
        this.logger?.logToolResult(
          message.toolName ?? 'tool',
          message.content,
          message.toolUseId,
          this.role,
          meta,
        );
        break;
      }

      case 'complete':
        if (message.sessionId && this.onSessionId) {
          await this.onSessionId(message.sessionId);
        }
        if (this.state.responseText) {
          this.logger?.logAssistantMessage(this.state.responseText, this.role, this.source);
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
        this.emitStreamFrame('done', {});
        break;

      case 'error':
        await this.sendEvent({
          type: ServerEventType.ERROR,
          error: message.error ?? 'Unknown error',
          agentId: this.role,
          monitorId: this.monitorId,
        });
        this.emitStreamFrame('error', { error: message.error ?? 'Unknown error' });
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

    // Emit final thinking event with this block's accumulated text
    await this.sendEvent({
      type: ServerEventType.AGENT_THINKING,
      content: this.state.thinkingText.slice(this.blockThinkingStart),
      agentId: this.role,
      monitorId: this.monitorId,
    });

    // Log only the new thinking text since last flush (handles multiple thinking blocks)
    const newText = this.state.thinkingText.slice(this.lastFlushedThinkingLength);
    if (newText) {
      this.logger?.logThinking(newText, this.role);
    }

    this.lastFlushedThinkingLength = this.state.thinkingText.length;
    this.thinkingDirty = false;
    this.lastThinkingEmitTime = 0;
  }
}
