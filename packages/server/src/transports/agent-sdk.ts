/**
 * Claude Agent SDK Transport.
 *
 * Uses the @anthropic-ai/claude-code SDK to communicate with Claude.
 * Authentication is handled via the Claude CLI's OAuth flow.
 */

import { query as sdkQuery, type Options as SDKOptions, type SDKMessage } from '@anthropic-ai/claude-code';
import type { AITransport, StreamMessage, TransportOptions } from './types.js';

export class AgentSDKTransport implements AITransport {
  readonly name = 'claude';
  private abortController?: AbortController;

  async isAvailable(): Promise<boolean> {
    // Agent SDK uses Claude CLI auth - check if CLI is installed
    try {
      const { execSync } = await import('child_process');
      execSync('claude --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async *query(
    prompt: string,
    options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    this.abortController = new AbortController();

    try {
      const sdkOptions: SDKOptions = {
        abortController: this.abortController,
        customSystemPrompt: options.systemPrompt,
        model: options.model ?? 'claude-sonnet-4-20250514',
        resume: options.sessionId,
        allowedTools: [], // Text generation only, no file tools
      };

      const stream = sdkQuery({
        prompt,
        options: sdkOptions,
      });

      for await (const msg of stream) {
        if (this.abortController.signal.aborted) break;
        const mapped = this.mapMessage(msg);
        if (mapped) yield mapped;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Expected when interrupted
        return;
      }
      yield {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private mapMessage(msg: SDKMessage): StreamMessage | null {
    // SDK message types: system, assistant, user, result, stream_event
    if (msg.type === 'system' && msg.subtype === 'init') {
      return { type: 'text', sessionId: msg.session_id };
    }

    if (msg.type === 'assistant') {
      const content = this.extractAssistantContent(msg.message);
      return { type: 'text', content, sessionId: msg.session_id };
    }

    if (msg.type === 'stream_event') {
      // Handle partial streaming events
      const event = msg.event;
      if (event.type === 'content_block_delta') {
        const delta = event.delta as { type: string; text?: string; thinking?: string };
        if (delta.type === 'text_delta' && delta.text) {
          return { type: 'text', content: delta.text };
        }
        if (delta.type === 'thinking_delta' && delta.thinking) {
          return { type: 'thinking', content: delta.thinking };
        }
      }
      return null; // Skip other stream events
    }

    if (msg.type === 'result') {
      return { type: 'complete', sessionId: msg.session_id };
    }

    // Skip user messages and other types
    return null;
  }

  private extractAssistantContent(message: unknown): string {
    if (!message || typeof message !== 'object') return '';

    const msg = message as Record<string, unknown>;
    const content = msg.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>).type === 'text'
        )
        .map((block) => block.text)
        .join('');
    }

    return '';
  }

  interrupt(): void {
    this.abortController?.abort();
  }

  async dispose(): Promise<void> {
    this.interrupt();
  }
}
