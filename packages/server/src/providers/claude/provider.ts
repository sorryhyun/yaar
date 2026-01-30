/**
 * Claude Agent SDK Provider.
 *
 * Uses the @anthropic-ai/claude-agent-sdk to communicate with Claude.
 * Authentication is handled via the Claude CLI's OAuth flow.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { mapClaudeMessage } from './message-mapper.js';
import { getToolNames, getMcpToken } from '../../mcp/index.js';
import { getStorageDir } from '../../storage/index.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

// Port for the MCP HTTP server (same as main server)
const MCP_PORT = parseInt(process.env.PORT ?? '8000', 10);

export class ClaudeProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt = SYSTEM_PROMPT;

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
        model: options.model ?? "claude-sonnet-4-5-20250929", // "claude-opus-4-5-20251101"
        resume: options.sessionId,
        forkSession: options.forkSession, // When true, creates a new session with context from resumed session
        // Set working directory to storage folder
        cwd: getStorageDir(),
        // Disable all default Claude Code tools - only use ClaudeOS MCP tools
        tools: ['WebFetch','WebSearch'],
        allowedTools: getToolNames(),
        maxThinkingTokens: 4096,
        // Connect to the HTTP MCP server for ClaudeOS tools
        mcpServers: {
          claudeos: {
            type: 'http',
            url: `http://127.0.0.1:${MCP_PORT}/mcp`,
            headers: {
              Authorization: `Bearer ${getMcpToken()}`,
            },
          },
        },
        includePartialMessages: true, // Enable streaming
        env: {
          ...process.env,
          MAX_MCP_OUTPUT_TOKENS: '7500', // Limit MCP tool output to avoid huge base64 payloads
        },
      };

      const stream = sdkQuery({
        prompt,
        options: sdkOptions,
      });

      let messageCount = 0;
      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;
        const mapped = mapClaudeMessage(msg);
        if (mapped) yield mapped;
      }
      if (messageCount === 0) {
        console.warn(`[ClaudeProvider] SDK returned empty stream for prompt: "${prompt.slice(0, 50)}..."`);
      } else {
        console.log(`[ClaudeProvider] SDK returned ${messageCount} messages`);
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
export { ClaudeProvider as AgentSDKProvider };
