/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 */

import type { WebSocket } from 'ws';
import type { AITransport, TransportOptions, ProviderType } from './transports/types.js';
import {
  createTransport,
  getFirstAvailableTransport,
  getAvailableTransports,
} from './transports/factory.js';
import { extractActions, extractToolCallInfo } from './action-parser.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { ServerEvent, OSAction } from '@claudeos/shared';

export class AgentSession {
  private ws: WebSocket;
  private transport: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /**
   * Initialize with the first available transport.
   */
  async initialize(): Promise<boolean> {
    this.transport = await getFirstAvailableTransport();

    if (!this.transport) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: this.transport.name,
      sessionId: this.sessionId ?? undefined,
    });

    return true;
  }

  /**
   * Process a user message through the AI provider.
   */
  async handleMessage(content: string): Promise<void> {
    if (!this.transport) {
      return;
    }

    this.running = true;

    try {
      const options: TransportOptions = {
        systemPrompt: SYSTEM_PROMPT,
        sessionId: this.sessionId ?? undefined,
      };

      let responseText = '';
      let thinkingText = '';
      let lastActions: OSAction[] = [];
      let lastToolCallCount = 0;

      for await (const message of this.transport.query(content, options)) {
        if (!this.running) break;

        switch (message.type) {
          case 'text':
            // Update session ID if provided
            if (message.sessionId) {
              this.sessionId = message.sessionId;
              await this.sendEvent({
                type: 'CONNECTION_STATUS',
                status: 'connected',
                provider: this.transport.name,
                sessionId: this.sessionId,
              });
            }

            // Accumulate response text
            if (message.content) {
              responseText += message.content;

              // Check for tool calls and show progress
              const toolCalls = extractToolCallInfo(responseText);
              if (toolCalls.length > lastToolCallCount) {
                const newTools = toolCalls.slice(lastToolCallCount);
                for (const tool of newTools) {
                  await this.sendEvent({
                    type: 'TOOL_PROGRESS',
                    toolName: tool.name,
                    status: 'running',
                  });
                }
                lastToolCallCount = toolCalls.length;
              }

              // Extract and send actions
              const actions = extractActions(responseText);
              if (actions.length > lastActions.length) {
                // Only send new actions
                const newActions = actions.slice(lastActions.length);
                await this.sendEvent({
                  type: 'ACTIONS',
                  actions: newActions,
                });
                // Mark tools as complete
                for (const tool of toolCalls.slice(0, newActions.length)) {
                  await this.sendEvent({
                    type: 'TOOL_PROGRESS',
                    toolName: tool.name,
                    status: 'complete',
                  });
                }
                lastActions = actions;
              }

              // Send response update
              await this.sendEvent({
                type: 'AGENT_RESPONSE',
                content: responseText,
                isComplete: false,
              });
            }
            break;

          case 'thinking':
            if (message.content) {
              thinkingText += message.content;
              await this.sendEvent({
                type: 'AGENT_THINKING',
                content: thinkingText,
              });
            }
            break;

          case 'tool_use':
            await this.sendEvent({
              type: 'TOOL_PROGRESS',
              toolName: message.toolName ?? 'unknown',
              status: 'running',
            });
            break;

          case 'tool_result':
            await this.sendEvent({
              type: 'TOOL_PROGRESS',
              toolName: 'tool',
              status: 'complete',
            });
            break;

          case 'complete':
            if (message.sessionId) {
              this.sessionId = message.sessionId;
            }
            await this.sendEvent({
              type: 'AGENT_RESPONSE',
              content: responseText,
              isComplete: true,
            });
            break;

          case 'error':
            await this.sendEvent({
              type: 'ERROR',
              error: message.error ?? 'Unknown error',
            });
            break;
        }
      }
    } catch (err) {
      await this.sendEvent({
        type: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Interrupt the current operation.
   */
  async interrupt(): Promise<void> {
    this.running = false;
    this.transport?.interrupt();
  }

  /**
   * Switch to a different provider.
   */
  async setProvider(providerType: ProviderType): Promise<void> {
    const available = await getAvailableTransports();
    if (!available.includes(providerType)) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Provider ${providerType} is not available.`,
      });
      return;
    }

    // Dispose current transport
    if (this.transport) {
      await this.transport.dispose();
    }

    // Create new transport (async with dynamic import)
    const newTransport = await createTransport(providerType);
    this.transport = newTransport;
    this.sessionId = null;

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: newTransport.name,
    });
  }

  /**
   * Send an event to the client.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Clean up resources.
   */
  async cleanup(): Promise<void> {
    if (this.transport) {
      await this.transport.dispose();
      this.transport = null;
    }
  }
}
