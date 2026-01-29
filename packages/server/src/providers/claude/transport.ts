/**
 * Claude Agent SDK Transport.
 *
 * Uses the @anthropic-ai/claude-agent-sdk to communicate with Claude.
 * Authentication is handled via the Claude CLI's OAuth flow.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { mapClaudeMessage } from './message-mapper.js';
import { claudeOSTools, getClaudeOSToolNames } from '../../tools/index.js';

export class ClaudeTransport extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';

  async isAvailable(): Promise<boolean> {
    // Agent SDK uses Claude CLI auth - check if CLI is installed
    return this.isCliAvailable('claude');
  }

  async *query(
    prompt: string,
    options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    const abortController = this.createAbortController();

    try {
      const sdkOptions: SDKOptions = {
        abortController,
        systemPrompt: options.systemPrompt,
        model: options.model ?? "claude-opus-4-5-20251101",
        resume: options.sessionId,
        // Disable all default Claude Code tools - only use ClaudeOS MCP tools
        tools: ['WebFetch','WebSearch'],
        allowedTools: getClaudeOSToolNames(),
        // Register the MCP server with custom tools
        mcpServers: {
          claudeos: claudeOSTools
        },
        includePartialMessages: true, // Enable streaming
      };

      const stream = sdkQuery({
        prompt,
        options: sdkOptions,
      });

      for await (const msg of stream) {
        if (this.isAborted()) break;
        const mapped = mapClaudeMessage(msg);
        if (mapped) yield mapped;
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        // Expected when interrupted
        return;
      }
      yield this.createErrorMessage(err);
    }
  }
}

// Re-export with legacy name for backwards compatibility
export { ClaudeTransport as AgentSDKTransport };
