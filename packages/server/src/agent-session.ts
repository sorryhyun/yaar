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
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { ServerEvent } from '@claudeos/shared';
import { createSession, SessionLogger } from './sessions/index.js';
import { actionEmitter, type ActionEvent } from './tools/index.js';

export class AgentSession {
  private ws: WebSocket;
  private transport: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    // Subscribe to actions emitted directly from tools
    this.unsubscribeAction = actionEmitter.onAction(this.handleToolAction.bind(this));
  }

  /**
   * Handle actions emitted directly from tools.
   */
  private async handleToolAction(event: ActionEvent): Promise<void> {
    await this.sendEvent({
      type: 'ACTIONS',
      actions: [event.action],
    });
    // Log action
    await this.sessionLogger?.logAction(event.action);
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

    // Create session logger
    const sessionInfo = await createSession(this.transport.name);
    this.sessionLogger = new SessionLogger(sessionInfo);

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

    // Log user message
    await this.sessionLogger?.logUserMessage(content);

    try {
      const options: TransportOptions = {
        systemPrompt: SYSTEM_PROMPT,
        sessionId: this.sessionId ?? undefined,
      };

      let responseText = '';
      let thinkingText = '';

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

            // Accumulate response text and send update
            if (message.content) {
              responseText += message.content;
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
            // Actions are emitted directly from tools via actionEmitter
            await this.sendEvent({
              type: 'TOOL_PROGRESS',
              toolName: message.toolName ?? 'tool',
              status: 'complete',
            });
            break;

          case 'complete':
            if (message.sessionId) {
              this.sessionId = message.sessionId;
            }
            // Log assistant response
            if (responseText) {
              await this.sessionLogger?.logAssistantMessage(responseText);
              await this.sessionLogger?.updateLastActivity();
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
    // Unsubscribe from action emitter
    if (this.unsubscribeAction) {
      this.unsubscribeAction();
      this.unsubscribeAction = null;
    }
    if (this.transport) {
      await this.transport.dispose();
      this.transport = null;
    }
  }
}
