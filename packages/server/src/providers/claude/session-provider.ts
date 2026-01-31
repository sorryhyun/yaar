/**
 * Claude Session Provider with warmup support.
 *
 * Pre-creates a session at startup by sending an init message,
 * then uses session resumption for actual user messages.
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

// Warmup message - simple ping/pong handshake (see system prompt)
const WARMUP_MESSAGE = 'ping';

/**
 * Claude provider with session warmup support.
 *
 * At startup, sends a warmup message to create a session. This:
 * 1. Establishes the MCP connection
 * 2. Loads the system prompt into context
 * 3. Gets a session ID for resumption
 *
 * Subsequent queries resume this pre-warmed session for faster response.
 */
export class ClaudeSessionProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt = SYSTEM_PROMPT;

  private sessionId: string | null = null;
  private warmedUp = false;
  private warmupPromise: Promise<boolean> | null = null;

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable('claude');
  }

  /**
   * Get SDK options for queries.
   */
  private getSDKOptions(resumeSession?: string): SDKOptions {
    return {
      abortController: this.createAbortController(),
      systemPrompt: this.systemPrompt,
      model: 'claude-sonnet-4-5-20250929',
      resume: resumeSession,
      cwd: getStorageDir(),
      tools: ['WebFetch', 'WebSearch'],
      allowedTools: getToolNames(),
      maxThinkingTokens: 4096,
      mcpServers: {
        claudeos: {
          type: 'http',
          url: `http://127.0.0.1:${MCP_PORT}/mcp`,
          headers: {
            Authorization: `Bearer ${getMcpToken()}`,
          },
        },
      },
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        MAX_MCP_OUTPUT_TOKENS: '7500',
      },
    };
  }

  /**
   * Warm up the session by sending an init message.
   * Returns true if warmup succeeded.
   */
  async warmup(): Promise<boolean> {
    if (this.warmedUp) {
      return true;
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = this.doWarmup();
    const result = await this.warmupPromise;
    this.warmupPromise = null;
    return result;
  }

  private async doWarmup(): Promise<boolean> {
    console.log('[ClaudeSessionProvider] Starting warmup...');

    try {
      const options = this.getSDKOptions();
      const stream = sdkQuery({ prompt: WARMUP_MESSAGE, options });

      for await (const msg of stream) {
        // Capture session ID from first message
        if ('session_id' in msg && msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id;
          console.log(`[ClaudeSessionProvider] Session created: ${this.sessionId}`);
        }

        // Wait for completion
        if (msg.type === 'result') {
          break;
        }
      }

      if (this.sessionId) {
        this.warmedUp = true;
        console.log('[ClaudeSessionProvider] Warmup complete');
        return true;
      } else {
        console.error('[ClaudeSessionProvider] Warmup failed: no session ID');
        return false;
      }
    } catch (err) {
      console.error('[ClaudeSessionProvider] Warmup error:', err);
      return false;
    }
  }

  /**
   * Get the session ID if available.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if the session is warmed up and ready.
   */
  isWarmedUp(): boolean {
    return this.warmedUp && this.sessionId !== null;
  }

  async *query(
    prompt: string,
    options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    // Determine which session to resume
    // Priority: options.sessionId > this.sessionId (warmed up)
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    console.log(`[ClaudeSessionProvider] query() - options.sessionId: ${options.sessionId}, this.sessionId: ${this.sessionId}, resumeSession: ${resumeSession}`);

    const sdkOptions = this.getSDKOptions(resumeSession);

    // Override model if specified
    if (options.model) {
      sdkOptions.model = options.model;
    }

    // Handle fork session
    if (options.forkSession && resumeSession) {
      sdkOptions.forkSession = true;
    }

    try {
      const stream = sdkQuery({ prompt, options: sdkOptions });
      let messageCount = 0;

      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;

        // Update session ID if we get a new one
        if ('session_id' in msg && msg.session_id) {
          // Only update our internal sessionId if we're not using an external one
          if (!options.sessionId) {
            this.sessionId = msg.session_id;
          }
        }

        const mapped = mapClaudeMessage(msg);
        if (mapped) {
          yield mapped;
        }
      }

      if (messageCount === 0) {
        console.warn(`[ClaudeSessionProvider] Empty response for: "${prompt.slice(0, 50)}..."`);
      } else {
        console.log(`[ClaudeSessionProvider] Received ${messageCount} messages`);
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        return;
      }
      yield this.createErrorMessage(err);
    }
  }

  async dispose(): Promise<void> {
    this.sessionId = null;
    this.warmedUp = false;
    await super.dispose();
  }
}
